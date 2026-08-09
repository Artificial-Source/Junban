//! Bounded HTTPS transport for plugin host callbacks.
//!
//! This leaf owns no runtime, supervisor, application service, or durable state.
//! Its caller must create [`DispatchingHttpPermit`] only after the exact plugin
//! invocation has durably entered `DispatchingHttp`. The permit is then spent by
//! the first callback attempt, including an attempt rejected during validation.

use std::{
    error::Error as StdError,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use junban_plugin_sdk::{
    HttpMethod as GrantedHttpMethod, HttpScope,
    private_body_types::{
        ByteList, DeliveryState, HttpError, HttpErrorCode, HttpHeader,
        HttpMethod as GuestHttpMethod, HttpRequest, HttpResponse,
    },
};
use reqwest::{
    Client, Method, Response, Url,
    header::{ACCEPT_ENCODING, HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
};

/// Exact connect and end-to-end transport deadline frozen by the plugin WIT.
pub const PLUGIN_HTTP_DEADLINE: Duration = Duration::from_secs(5);
/// Request and guest-visible response body ceiling.
pub const PLUGIN_HTTP_BODY_BYTES_MAX: usize = 1024 * 1024;
/// Maximum request or raw response header entries.
pub const PLUGIN_HTTP_HEADER_ENTRIES_MAX: usize = 32;
/// Maximum bytes in one header name.
pub const PLUGIN_HTTP_HEADER_NAME_BYTES_MAX: usize = 64;
/// Maximum bytes in one header value.
pub const PLUGIN_HTTP_HEADER_VALUE_BYTES_MAX: usize = 8 * 1024;
/// Maximum aggregate name-plus-value bytes in one header block.
pub const PLUGIN_HTTP_HEADER_BYTES_MAX: usize = 64 * 1024;
/// Bounded canonical path-and-query string.
pub const PLUGIN_HTTP_PATH_AND_QUERY_BYTES_MAX: usize = 8 * 1024;
/// Maximum DNS answers inspected before failing closed.
pub const PLUGIN_HTTP_DNS_ANSWERS_MAX: usize = 32;

const PLUGIN_HTTP_ORIGIN_BYTES_MAX: usize = 272;
const PLUGIN_HTTP_DELIVERY_ID_BYTES_MAX: usize = 128;
const DELIVERY_ID_HEADER: &str = "x-junban-plugin-delivery-id";

const REQUEST_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "content-type",
    "if-match",
    "if-none-match",
];
const RESPONSE_HEADERS: &[&str] = &[
    "cache-control",
    "content-language",
    "content-type",
    "etag",
    "expires",
    "last-modified",
    "location",
    "retry-after",
];

/// A consume-once authority created only after durable `DispatchingHttp`.
///
/// The type is deliberately neither `Clone` nor `Default`. A validation failure
/// still spends it so guest code cannot probe repeatedly or make a second call.
#[derive(Debug)]
pub struct DispatchingHttpPermit {
    spent: bool,
}

impl DispatchingHttpPermit {
    /// Construct after the caller has durably transitioned the invocation.
    #[must_use]
    pub fn after_durable_transition() -> Self {
        Self { spent: false }
    }

    /// Whether this top-level invocation's logical HTTP callback was consumed.
    #[must_use]
    pub fn is_spent(&self) -> bool {
        self.spent
    }

    fn spend(&mut self) -> Result<(), HttpError> {
        if self.spent {
            return Err(http_error(
                HttpErrorCode::PermissionDenied,
                DeliveryState::NotSent,
                "plugin HTTP permit was already spent",
            ));
        }
        self.spent = true;
        Ok(())
    }
}

/// Stateless plugin HTTPS transport.
///
/// A fresh DNS answer and a fresh one-destination client are used for every
/// call. There is no internal retry or connection reuse across calls.
#[derive(Debug, Default)]
pub struct PluginHttpTransport;

impl PluginHttpTransport {
    /// Create the uncomposed transport leaf without constructing a client.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Perform one already-durable logical callback.
    ///
    /// The caller supplies the exact generation-bound HTTP grant and stable
    /// delivery ID. No diagnostics include URL, header, body, or resolver data.
    pub async fn request(
        &self,
        permit: &mut DispatchingHttpPermit,
        grant: &HttpScope,
        request: HttpRequest,
        delivery_id: &str,
    ) -> Result<HttpResponse, HttpError> {
        permit.spend()?;
        let request = ValidatedRequest::new(grant, request, delivery_id)?;
        let mut progress = TransportProgress::NotSent;

        match tokio::time::timeout(
            PLUGIN_HTTP_DEADLINE,
            execute_validated(&request, &mut progress),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(deadline_error(progress)),
        }
    }
}

#[derive(Debug)]
struct ValidatedRequest {
    method: Method,
    url: Url,
    host: String,
    port: u16,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl ValidatedRequest {
    fn new(grant: &HttpScope, request: HttpRequest, delivery_id: &str) -> Result<Self, HttpError> {
        let origin = ValidatedOrigin::parse(&request.origin)?;
        if !grant
            .origins
            .iter()
            .any(|configured| configured.0 == request.origin)
        {
            return Err(permission_denied());
        }

        let granted_method = granted_method(request.method);
        if !grant.methods.contains(&granted_method) {
            return Err(permission_denied());
        }

        let url = validate_path_and_query(&request.origin, &request.path_and_query)?;
        let headers = validate_request_headers(&request.headers, delivery_id)?;
        if request.body.as_slice().len() > PLUGIN_HTTP_BODY_BYTES_MAX {
            return Err(invalid_request());
        }

        Ok(Self {
            method: request_method(request.method),
            url,
            host: origin.host,
            port: origin.port,
            headers,
            body: request.body.into_vec(),
        })
    }

    fn build(&self, client: &Client) -> Result<reqwest::Request, HttpError> {
        client
            .request(self.method.clone(), self.url.clone())
            .headers(self.headers.clone())
            .body(self.body.clone())
            .build()
            .map_err(|_| invalid_request())
    }
}

#[derive(Debug, Eq, PartialEq)]
struct ValidatedOrigin {
    host: String,
    port: u16,
}

impl ValidatedOrigin {
    fn parse(raw: &str) -> Result<Self, HttpError> {
        if raw.is_empty() || raw.len() > PLUGIN_HTTP_ORIGIN_BYTES_MAX || !raw.is_ascii() {
            return Err(invalid_request());
        }
        let url = Url::parse(raw).map_err(|_| invalid_request())?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || url.origin().ascii_serialization() != raw
        {
            return Err(invalid_request());
        }

        let host = url.host_str().ok_or_else(invalid_request)?;
        if !valid_dns_name(host) {
            return Err(invalid_request());
        }
        let port = url.port().unwrap_or(443);
        if port == 0 {
            return Err(invalid_request());
        }
        Ok(Self {
            host: host.to_owned(),
            port,
        })
    }
}

fn valid_dns_name(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host == host.to_ascii_lowercase()
        && !host.ends_with('.')
        && !host.eq("localhost")
        && !host.ends_with(".localhost")
        && !host.ends_with(".local")
        && host.parse::<IpAddr>().is_err()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && !label.starts_with("xn--")
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn validate_path_and_query(origin: &str, raw: &str) -> Result<Url, HttpError> {
    if raw.is_empty()
        || raw.len() > PLUGIN_HTTP_PATH_AND_QUERY_BYTES_MAX
        || !raw.is_ascii()
        || !raw.starts_with('/')
        || raw.starts_with("//")
        || raw.contains(['#', '\\'])
        || raw.bytes().any(|byte| byte.is_ascii_control())
        || !has_canonical_percent_encoding(raw)
    {
        return Err(invalid_request());
    }

    let joined = format!("{origin}{raw}");
    let url = Url::parse(&joined).map_err(|_| invalid_request())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != origin
    {
        return Err(invalid_request());
    }

    let canonical = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    if canonical != raw {
        return Err(invalid_request());
    }
    Ok(url)
}

fn has_canonical_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        let Some(encoded) = bytes.get(index + 1..index + 3) else {
            return false;
        };
        if !encoded
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(byte))
        {
            return false;
        }
        index += 3;
    }
    true
}

fn validate_request_headers(
    headers: &[HttpHeader],
    delivery_id: &str,
) -> Result<HeaderMap, HttpError> {
    if delivery_id.is_empty()
        || !valid_header_value(delivery_id.as_bytes())
        || delivery_id.len() > PLUGIN_HTTP_DELIVERY_ID_BYTES_MAX
    {
        return Err(invalid_request());
    }
    validate_header_count(headers.len()).map_err(|_| invalid_request())?;

    let mut aggregate = 0_usize;
    let mut previous: Option<&str> = None;
    let mut output = HeaderMap::with_capacity(headers.len() + 2);
    for header in headers {
        if !valid_header_name(&header.name)
            || !REQUEST_HEADERS.contains(&header.name.as_str())
            || previous.is_some_and(|name| name >= header.name.as_str())
            || !valid_header_value(header.value.as_bytes())
        {
            return Err(invalid_request());
        }
        aggregate = add_header_bytes(aggregate, header.name.len(), header.value.len())
            .map_err(|_| invalid_request())?;

        let name = HeaderName::from_bytes(header.name.as_bytes()).map_err(|_| invalid_request())?;
        let value =
            HeaderValue::from_bytes(header.value.as_bytes()).map_err(|_| invalid_request())?;
        output.insert(name, value);
        previous = Some(&header.name);
    }

    output.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    output.insert(
        HeaderName::from_static(DELIVERY_ID_HEADER),
        HeaderValue::from_bytes(delivery_id.as_bytes()).map_err(|_| invalid_request())?,
    );
    Ok(output)
}

fn validate_response_headers(headers: &HeaderMap) -> Result<Vec<HttpHeader>, HttpError> {
    validate_header_count(headers.len()).map_err(|_| invalid_response())?;
    let mut aggregate = 0_usize;
    for (name, value) in headers {
        if !valid_header_name(name.as_str()) || !valid_header_value(value.as_bytes()) {
            return Err(invalid_response());
        }
        aggregate = add_header_bytes(aggregate, name.as_str().len(), value.as_bytes().len())
            .map_err(|_| invalid_response())?;
    }

    let mut output = Vec::with_capacity(RESPONSE_HEADERS.len());
    for name in RESPONSE_HEADERS {
        let mut values = headers.get_all(*name).iter();
        let Some(value) = values.next() else {
            continue;
        };
        if values.next().is_some() {
            return Err(invalid_response());
        }
        let value = value.to_str().map_err(|_| invalid_response())?;
        output.push(HttpHeader {
            name: (*name).to_owned(),
            value: value.to_owned(),
        });
    }
    Ok(output)
}

fn validate_header_count(count: usize) -> Result<(), ()> {
    if count > PLUGIN_HTTP_HEADER_ENTRIES_MAX {
        Err(())
    } else {
        Ok(())
    }
}

fn add_header_bytes(aggregate: usize, name: usize, value: usize) -> Result<usize, ()> {
    let aggregate = aggregate
        .checked_add(name)
        .and_then(|n| n.checked_add(value))
        .ok_or(())?;
    if aggregate > PLUGIN_HTTP_HEADER_BYTES_MAX {
        Err(())
    } else {
        Ok(aggregate)
    }
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= PLUGIN_HTTP_HEADER_NAME_BYTES_MAX
        && name.bytes().all(is_http_token_byte)
        && !name.bytes().any(|byte| byte.is_ascii_uppercase())
}

fn is_http_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn valid_header_value(value: &[u8]) -> bool {
    if value.len() > PLUGIN_HTTP_HEADER_VALUE_BYTES_MAX {
        return false;
    }
    if value
        .first()
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
        || value
            .last()
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        return false;
    }
    value
        .iter()
        .all(|byte| *byte == b'\t' || (b' '..=b'~').contains(byte))
}

fn granted_method(method: GuestHttpMethod) -> GrantedHttpMethod {
    match method {
        GuestHttpMethod::Get => GrantedHttpMethod::Get,
        GuestHttpMethod::Post => GrantedHttpMethod::Post,
        GuestHttpMethod::Put => GrantedHttpMethod::Put,
        GuestHttpMethod::Patch => GrantedHttpMethod::Patch,
        GuestHttpMethod::Delete => GrantedHttpMethod::Delete,
    }
}

fn request_method(method: GuestHttpMethod) -> Method {
    match method {
        GuestHttpMethod::Get => Method::GET,
        GuestHttpMethod::Post => Method::POST,
        GuestHttpMethod::Put => Method::PUT,
        GuestHttpMethod::Patch => Method::PATCH,
        GuestHttpMethod::Delete => Method::DELETE,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PinnedDestination {
    host: String,
    address: SocketAddr,
}

async fn resolve_destination(request: &ValidatedRequest) -> Result<PinnedDestination, HttpError> {
    let answers = tokio::net::lookup_host((request.host.as_str(), request.port))
        .await
        .map_err(|_| dns_denied())?;
    let mut bounded = Vec::with_capacity(4);
    for answer in answers {
        if bounded.len() == PLUGIN_HTTP_DNS_ANSWERS_MAX {
            return Err(dns_denied());
        }
        bounded.push(answer);
    }
    pin_destination(&request.host, request.port, &bounded)
}

fn pin_destination(
    host: &str,
    port: u16,
    answers: &[SocketAddr],
) -> Result<PinnedDestination, HttpError> {
    if answers.is_empty() || answers.len() > PLUGIN_HTTP_DNS_ANSWERS_MAX {
        return Err(dns_denied());
    }
    for answer in answers {
        if answer.port() != port
            || matches!(answer, SocketAddr::V6(address) if address.scope_id() != 0)
            || !is_public_destination(answer.ip())
        {
            return Err(dns_denied());
        }
    }
    Ok(PinnedDestination {
        host: host.to_owned(),
        address: answers[0],
    })
}

fn is_public_destination(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let denied = [
        (Ipv4Addr::new(0, 0, 0, 0), 8),
        (Ipv4Addr::new(10, 0, 0, 0), 8),
        (Ipv4Addr::new(100, 64, 0, 0), 10),
        (Ipv4Addr::new(127, 0, 0, 0), 8),
        (Ipv4Addr::new(169, 254, 0, 0), 16),
        (Ipv4Addr::new(172, 16, 0, 0), 12),
        (Ipv4Addr::new(192, 0, 0, 0), 24),
        (Ipv4Addr::new(192, 0, 2, 0), 24),
        (Ipv4Addr::new(192, 31, 196, 0), 24),
        (Ipv4Addr::new(192, 52, 193, 0), 24),
        (Ipv4Addr::new(192, 88, 99, 0), 24),
        (Ipv4Addr::new(192, 168, 0, 0), 16),
        (Ipv4Addr::new(192, 175, 48, 0), 24),
        (Ipv4Addr::new(198, 18, 0, 0), 15),
        (Ipv4Addr::new(198, 51, 100, 0), 24),
        (Ipv4Addr::new(203, 0, 113, 0), 24),
        (Ipv4Addr::new(224, 0, 0, 0), 4),
        (Ipv4Addr::new(240, 0, 0, 0), 4),
    ];
    !denied
        .iter()
        .any(|(network, prefix)| ipv4_in_prefix(address, *network, *prefix))
}

fn ipv4_in_prefix(address: Ipv4Addr, network: Ipv4Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    u32::from(address) & mask == u32::from(network) & mask
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    // Fail closed outside the currently allocated global-unicast 2000::/3.
    if !ipv6_in_prefix(address, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3) {
        return false;
    }
    let denied = [
        (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
        (Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32),
        (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
        (Ipv6Addr::new(0x2620, 0x004f, 0x8000, 0, 0, 0, 0, 0), 48),
        (Ipv6Addr::new(0x3ffe, 0, 0, 0, 0, 0, 0, 0), 16),
        (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),
    ];
    !denied
        .iter()
        .any(|(network, prefix)| ipv6_in_prefix(address, *network, *prefix))
}

fn ipv6_in_prefix(address: Ipv6Addr, network: Ipv6Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - u32::from(prefix))
    };
    u128::from(address) & mask == u128::from(network) & mask
}

fn build_pinned_client(destination: &PinnedDestination) -> Result<Client, HttpError> {
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .retry(reqwest::retry::never())
        .https_only(true)
        .connect_timeout(PLUGIN_HTTP_DEADLINE)
        .timeout(PLUGIN_HTTP_DEADLINE)
        .pool_max_idle_per_host(0)
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .resolve(&destination.host, destination.address)
        .build()
        .map_err(|_| {
            http_error(
                HttpErrorCode::TlsFailed,
                DeliveryState::NotSent,
                "plugin HTTPS setup failed",
            )
        })
}

async fn execute_validated(
    request: &ValidatedRequest,
    progress: &mut TransportProgress,
) -> Result<HttpResponse, HttpError> {
    let destination = resolve_destination(request).await?;
    let client = build_pinned_client(&destination)?;
    let request = request.build(&client)?;

    *progress = TransportProgress::MayHaveBeenSent;
    let response = client
        .execute(request)
        .await
        .map_err(|error| classify_reqwest_error(&error, *progress))?;
    *progress = TransportProgress::ResponseReceived;
    collect_response(response).await
}

async fn collect_response(mut response: Response) -> Result<HttpResponse, HttpError> {
    let status = response.status().as_u16();
    let headers = validate_response_headers(response.headers())?;
    let mut body = BoundedResponseBody::new(response.content_length());
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| classify_reqwest_error(&error, TransportProgress::ResponseReceived))?;
        let Some(chunk) = chunk else {
            break;
        };
        if body.push(&chunk) {
            break;
        }
    }

    Ok(HttpResponse {
        status,
        headers,
        body: ByteList::new(body.bytes).map_err(|_| {
            classified_error(
                FailureKind::Unavailable,
                TransportProgress::ResponseReceived,
            )
        })?,
        truncated: body.truncated,
    })
}

#[derive(Debug)]
struct BoundedResponseBody {
    bytes: Vec<u8>,
    truncated: bool,
}

impl BoundedResponseBody {
    fn new(content_length: Option<u64>) -> Self {
        let capacity = content_length
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(PLUGIN_HTTP_BODY_BYTES_MAX);
        Self {
            bytes: Vec::with_capacity(capacity),
            truncated: false,
        }
    }

    /// Returns true as soon as one byte beyond the retained prefix is observed.
    fn push(&mut self, chunk: &[u8]) -> bool {
        if chunk.is_empty() {
            return false;
        }
        let remaining = PLUGIN_HTTP_BODY_BYTES_MAX.saturating_sub(self.bytes.len());
        let take = remaining.min(chunk.len());
        self.bytes.extend_from_slice(&chunk[..take]);
        if take < chunk.len() || remaining == 0 {
            self.truncated = true;
        }
        self.truncated
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransportProgress {
    NotSent,
    MayHaveBeenSent,
    ResponseReceived,
}

impl TransportProgress {
    const fn delivery(self) -> DeliveryState {
        match self {
            Self::NotSent => DeliveryState::NotSent,
            Self::MayHaveBeenSent => DeliveryState::MayHaveBeenSent,
            Self::ResponseReceived => DeliveryState::ResponseReceived,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FailureKind {
    Timeout,
    Tls,
    Connect,
    Ambiguous,
    Unavailable,
}

fn classify_reqwest_error(error: &reqwest::Error, progress: TransportProgress) -> HttpError {
    if progress == TransportProgress::MayHaveBeenSent {
        if error.is_connect() {
            let kind = if error.is_timeout() {
                FailureKind::Timeout
            } else if contains_tls_io_error(error) {
                FailureKind::Tls
            } else {
                FailureKind::Connect
            };
            // This client is fresh and has no idle pool. A connector or TLS
            // error occurs before reqwest can write the HTTP request.
            return classified_error(kind, TransportProgress::NotSent);
        }
        // Once reqwest owns a connected request, its remaining error surface
        // cannot prove that the remote endpoint saw no request bytes.
        return classified_error(FailureKind::Ambiguous, progress);
    }

    let kind = if error.is_timeout() {
        FailureKind::Timeout
    } else {
        FailureKind::Unavailable
    };
    classified_error(kind, progress)
}

fn deadline_error(progress: TransportProgress) -> HttpError {
    if progress == TransportProgress::MayHaveBeenSent {
        classified_error(FailureKind::Ambiguous, progress)
    } else {
        classified_error(FailureKind::Timeout, progress)
    }
}

fn contains_tls_io_error(error: &reqwest::Error) -> bool {
    let mut source = error.source();
    while let Some(current) = source {
        if let Some(io_error) = current.downcast_ref::<io::Error>()
            && matches!(
                io_error.kind(),
                io::ErrorKind::InvalidData | io::ErrorKind::Other
            )
            && io_error.get_ref().is_some()
        {
            return true;
        }
        source = current.source();
    }
    false
}

fn classified_error(kind: FailureKind, progress: TransportProgress) -> HttpError {
    let (code, message) = match kind {
        FailureKind::Timeout => (HttpErrorCode::Timeout, "plugin HTTP request timed out"),
        FailureKind::Tls => (HttpErrorCode::TlsFailed, "plugin HTTPS handshake failed"),
        FailureKind::Connect => (
            HttpErrorCode::ConnectFailed,
            "plugin HTTPS connection failed",
        ),
        FailureKind::Ambiguous => (
            HttpErrorCode::DeliveryAmbiguous,
            "plugin HTTP delivery is ambiguous",
        ),
        FailureKind::Unavailable => (
            HttpErrorCode::Unavailable,
            "plugin HTTP transport is unavailable",
        ),
    };
    http_error(code, progress.delivery(), message)
}

fn invalid_request() -> HttpError {
    http_error(
        HttpErrorCode::InvalidRequest,
        DeliveryState::NotSent,
        "plugin HTTP request is invalid",
    )
}

fn permission_denied() -> HttpError {
    http_error(
        HttpErrorCode::PermissionDenied,
        DeliveryState::NotSent,
        "plugin HTTP request is not permitted",
    )
}

fn dns_denied() -> HttpError {
    http_error(
        HttpErrorCode::DnsDenied,
        DeliveryState::NotSent,
        "plugin HTTP destination was denied",
    )
}

fn invalid_response() -> HttpError {
    http_error(
        HttpErrorCode::InvalidResponse,
        DeliveryState::ResponseReceived,
        "plugin HTTP response is invalid",
    )
}

fn http_error(code: HttpErrorCode, delivery: DeliveryState, message: &'static str) -> HttpError {
    HttpError {
        code,
        delivery,
        retryable: false,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_plugin_sdk::{HttpOrigin, private_body_types::HttpMethod as GuestMethod};

    fn grant(origins: &[&str], methods: &[GrantedHttpMethod]) -> HttpScope {
        HttpScope {
            origins: origins
                .iter()
                .map(|origin| HttpOrigin((*origin).to_owned()))
                .collect(),
            methods: methods.to_vec(),
        }
    }

    fn request(method: GuestMethod, origin: &str, path: &str) -> HttpRequest {
        HttpRequest {
            method,
            origin: origin.to_owned(),
            path_and_query: path.to_owned(),
            headers: Vec::new(),
            body: ByteList::new(Vec::new()).unwrap(),
        }
    }

    fn validate(request: HttpRequest, grant: &HttpScope) -> Result<ValidatedRequest, HttpError> {
        ValidatedRequest::new(grant, request, "delivery-1")
    }

    fn assert_error(error: HttpError, code: HttpErrorCode, delivery: DeliveryState) {
        assert_eq!(error.code, code);
        assert_eq!(error.delivery, delivery);
        assert!(!error.retryable);
        assert!(error.message.len() <= 512);
        assert!(!error.message.contains("example.com"));
    }

    #[test]
    fn exact_origin_method_and_url_are_required() {
        let grant = grant(
            &["https://api.example.com", "https://api.example.com:8443"],
            &[GrantedHttpMethod::Get, GrantedHttpMethod::Post],
        );
        let validated = validate(
            request(
                GuestMethod::Get,
                "https://api.example.com:8443",
                "/v1/items?limit=2",
            ),
            &grant,
        )
        .unwrap();
        assert_eq!(validated.host, "api.example.com");
        assert_eq!(validated.port, 8443);
        assert_eq!(
            validated.url.as_str(),
            "https://api.example.com:8443/v1/items?limit=2"
        );

        let error = validate(
            request(GuestMethod::Put, "https://api.example.com", "/v1"),
            &grant,
        )
        .unwrap_err();
        assert_error(
            error,
            HttpErrorCode::PermissionDenied,
            DeliveryState::NotSent,
        );
        let error = validate(
            request(GuestMethod::Get, "https://other.example.com", "/v1"),
            &grant,
        )
        .unwrap_err();
        assert_error(
            error,
            HttpErrorCode::PermissionDenied,
            DeliveryState::NotSent,
        );
    }

    #[test]
    fn every_method_maps_exactly_to_grant_and_transport() {
        let cases = [
            (GuestMethod::Get, GrantedHttpMethod::Get, Method::GET),
            (GuestMethod::Post, GrantedHttpMethod::Post, Method::POST),
            (GuestMethod::Put, GrantedHttpMethod::Put, Method::PUT),
            (GuestMethod::Patch, GrantedHttpMethod::Patch, Method::PATCH),
            (
                GuestMethod::Delete,
                GrantedHttpMethod::Delete,
                Method::DELETE,
            ),
        ];
        for (guest, granted, transport) in cases {
            assert_eq!(granted_method(guest), granted);
            assert_eq!(request_method(guest), transport);
            assert!(
                validate(
                    request(guest, "https://api.example.com", "/"),
                    &grant(&["https://api.example.com"], &[granted]),
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn malformed_or_credential_bearing_origins_are_rejected() {
        for origin in [
            "http://api.example.com",
            "https://user@api.example.com",
            "https://user:pass@api.example.com",
            "https://api.example.com/",
            "https://api.example.com/path",
            "https://api.example.com?token=secret",
            "https://api.example.com#fragment",
            "https://api.example.com:443",
            "https://api.example.com:0",
            "https://API.example.com",
            "https://api.example.com.",
            "https://localhost",
            "https://service.local",
            "https://127.0.0.1",
            "https://[2606:4700:4700::1111]",
            "https://*.example.com",
            "https://xn--bcher-kva.example",
            "https://bücher.example",
        ] {
            let error = validate(
                request(GuestMethod::Get, origin, "/"),
                &grant(&[origin], &[GrantedHttpMethod::Get]),
            )
            .unwrap_err();
            assert_error(error, HttpErrorCode::InvalidRequest, DeliveryState::NotSent);
        }
    }

    #[test]
    fn path_and_query_must_be_canonical_origin_form() {
        let grant = grant(&["https://api.example.com"], &[GrantedHttpMethod::Get]);
        for path in [
            "",
            "relative",
            "//other.example/path",
            "https://other.example/path",
            "/path#fragment",
            "/a/../b",
            "/a/%2e%2e/b",
            "/bad%escape",
            "/bad%2fcase",
            "/truncated%2",
            "/back\\slash",
            "/space here",
            "/line\nfeed",
            "/é",
        ] {
            let error = validate(
                request(GuestMethod::Get, "https://api.example.com", path),
                &grant,
            )
            .unwrap_err();
            assert_error(error, HttpErrorCode::InvalidRequest, DeliveryState::NotSent);
        }
        assert!(
            validate(
                request(
                    GuestMethod::Get,
                    "https://api.example.com",
                    "/a%20b?empty=&q=%2F",
                ),
                &grant,
            )
            .is_ok()
        );
        assert!(
            validate(
                request(GuestMethod::Get, "https://api.example.com", "/path?"),
                &grant,
            )
            .is_ok()
        );
    }

    #[test]
    fn path_and_request_body_bounds_are_exact() {
        let grant = grant(&["https://api.example.com"], &[GrantedHttpMethod::Post]);
        let path = format!("/{}", "a".repeat(PLUGIN_HTTP_PATH_AND_QUERY_BYTES_MAX - 1));
        assert!(
            validate(
                request(GuestMethod::Post, "https://api.example.com", &path),
                &grant,
            )
            .is_ok()
        );
        let oversized_path = format!("/{}", "a".repeat(PLUGIN_HTTP_PATH_AND_QUERY_BYTES_MAX));
        assert!(
            validate(
                request(
                    GuestMethod::Post,
                    "https://api.example.com",
                    &oversized_path,
                ),
                &grant,
            )
            .is_err()
        );

        let mut exact = request(GuestMethod::Post, "https://api.example.com", "/");
        exact.body = ByteList::new(vec![0; PLUGIN_HTTP_BODY_BYTES_MAX]).unwrap();
        assert!(validate(exact, &grant).is_ok());
        let mut oversized = request(GuestMethod::Post, "https://api.example.com", "/");
        oversized.body = ByteList::new(vec![0; PLUGIN_HTTP_BODY_BYTES_MAX + 1]).unwrap();
        let error = validate(oversized, &grant).unwrap_err();
        assert_error(error, HttpErrorCode::InvalidRequest, DeliveryState::NotSent);
    }

    #[test]
    fn request_header_allowlist_order_duplicates_and_transport_ownership_are_exact() {
        let all = REQUEST_HEADERS
            .iter()
            .map(|name| HttpHeader {
                name: (*name).to_owned(),
                value: "value".to_owned(),
            })
            .collect::<Vec<_>>();
        let headers = validate_request_headers(&all, "delivery-1").unwrap();
        for name in REQUEST_HEADERS {
            assert_eq!(headers.get(*name).unwrap(), "value");
        }
        assert_eq!(headers.get(ACCEPT_ENCODING).unwrap(), "identity");
        assert_eq!(headers.get(DELIVERY_ID_HEADER).unwrap(), "delivery-1");
        assert!(headers.get("host").is_none());
        assert!(headers.get("content-length").is_none());

        let mut reversed = all.clone();
        reversed.reverse();
        assert!(validate_request_headers(&reversed, "delivery-1").is_err());
        let duplicate = vec![all[0].clone(), all[0].clone()];
        assert!(validate_request_headers(&duplicate, "delivery-1").is_err());
        let uppercase = vec![HttpHeader {
            name: "Accept".to_owned(),
            value: "value".to_owned(),
        }];
        assert!(validate_request_headers(&uppercase, "delivery-1").is_err());
    }

    #[test]
    fn forbidden_guest_headers_and_invalid_tokens_are_rejected() {
        for name in [
            "authorization",
            "proxy-authorization",
            "proxy-authenticate",
            "proxy-connection",
            "cookie",
            "cookie2",
            "set-cookie",
            "host",
            "content-length",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-port",
            "x-forwarded-proto",
            "x-real-ip",
            "via",
            "connection",
            "keep-alive",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "accept-encoding",
            "x-junban-plugin-delivery-id",
            "x-junban-secret",
            "bad name",
            "bad:name",
            "",
        ] {
            let headers = [HttpHeader {
                name: name.to_owned(),
                value: "value".to_owned(),
            }];
            assert!(
                validate_request_headers(&headers, "delivery-1").is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn header_value_and_per_field_boundaries_are_exact() {
        for value in ["", "visible ASCII", "one\ttwo", "!~"] {
            let headers = [HttpHeader {
                name: "accept".to_owned(),
                value: value.to_owned(),
            }];
            assert!(validate_request_headers(&headers, "delivery-1").is_ok());
        }
        for value in [
            " leading",
            "trailing ",
            "\tleading",
            "trailing\t",
            "line\nfeed",
            "carriage\rreturn",
            "nul\0byte",
            "escape\u{1b}",
            "non-ascii-é",
        ] {
            let headers = [HttpHeader {
                name: "accept".to_owned(),
                value: value.to_owned(),
            }];
            assert!(validate_request_headers(&headers, "delivery-1").is_err());
        }
        let exact = [HttpHeader {
            name: "accept".to_owned(),
            value: "a".repeat(PLUGIN_HTTP_HEADER_VALUE_BYTES_MAX),
        }];
        assert!(validate_request_headers(&exact, "delivery-1").is_ok());
        let oversized = [HttpHeader {
            name: "accept".to_owned(),
            value: "a".repeat(PLUGIN_HTTP_HEADER_VALUE_BYTES_MAX + 1),
        }];
        assert!(validate_request_headers(&oversized, "delivery-1").is_err());
        assert!(valid_header_name(
            &"a".repeat(PLUGIN_HTTP_HEADER_NAME_BYTES_MAX)
        ));
        assert!(!valid_header_name(
            &"a".repeat(PLUGIN_HTTP_HEADER_NAME_BYTES_MAX + 1)
        ));
    }

    #[test]
    fn header_count_and_aggregate_boundaries_are_exact() {
        assert!(validate_header_count(PLUGIN_HTTP_HEADER_ENTRIES_MAX).is_ok());
        assert!(validate_header_count(PLUGIN_HTTP_HEADER_ENTRIES_MAX + 1).is_err());
        assert_eq!(
            add_header_bytes(0, 64, PLUGIN_HTTP_HEADER_BYTES_MAX - 64),
            Ok(PLUGIN_HTTP_HEADER_BYTES_MAX)
        );
        assert!(add_header_bytes(PLUGIN_HTTP_HEADER_BYTES_MAX, 1, 0).is_err());
        assert!(add_header_bytes(usize::MAX, 1, 0).is_err());
    }

    #[test]
    fn response_allowlist_is_deterministic_and_unknown_valid_headers_are_omitted() {
        let mut raw = HeaderMap::new();
        for name in RESPONSE_HEADERS.iter().rev() {
            raw.insert(*name, HeaderValue::from_static("value"));
        }
        raw.insert("server", HeaderValue::from_static("hidden"));
        raw.insert("set-cookie", HeaderValue::from_static("hidden=value"));
        let exposed = validate_response_headers(&raw).unwrap();
        assert_eq!(
            exposed
                .iter()
                .map(|header| header.name.as_str())
                .collect::<Vec<_>>(),
            RESPONSE_HEADERS
        );
        assert!(exposed.iter().all(|header| header.value == "value"));
    }

    #[test]
    fn response_duplicate_allowed_names_and_invalid_raw_metadata_fail_closed() {
        let mut duplicate = HeaderMap::new();
        duplicate.append("etag", HeaderValue::from_static("one"));
        duplicate.append("etag", HeaderValue::from_static("two"));
        let error = validate_response_headers(&duplicate).unwrap_err();
        assert_error(
            error,
            HttpErrorCode::InvalidResponse,
            DeliveryState::ResponseReceived,
        );

        let mut unknown_duplicate = HeaderMap::new();
        unknown_duplicate.append("x-unknown", HeaderValue::from_static("one"));
        unknown_duplicate.append("x-unknown", HeaderValue::from_static("two"));
        assert_eq!(
            validate_response_headers(&unknown_duplicate).unwrap(),
            Vec::new()
        );

        let mut invalid_value = HeaderMap::new();
        invalid_value.insert(
            "x-unknown",
            HeaderValue::from_bytes(&[0x80]).expect("obs-text is accepted by HeaderValue"),
        );
        assert!(validate_response_headers(&invalid_value).is_err());

        let mut oversized_name = HeaderMap::new();
        let name =
            HeaderName::from_bytes("x".repeat(PLUGIN_HTTP_HEADER_NAME_BYTES_MAX + 1).as_bytes())
                .unwrap();
        oversized_name.insert(name, HeaderValue::from_static("value"));
        assert!(validate_response_headers(&oversized_name).is_err());

        let mut oversized_value = HeaderMap::new();
        oversized_value.insert(
            "x-unknown",
            HeaderValue::from_bytes(&vec![b'a'; PLUGIN_HTTP_HEADER_VALUE_BYTES_MAX + 1]).unwrap(),
        );
        assert!(validate_response_headers(&oversized_value).is_err());
    }

    #[test]
    fn raw_response_count_and_aggregate_limits_include_omitted_headers() {
        let mut count = HeaderMap::new();
        for index in 0..=PLUGIN_HTTP_HEADER_ENTRIES_MAX {
            let name = HeaderName::from_bytes(format!("x-{index:02}").as_bytes()).unwrap();
            count.insert(name, HeaderValue::from_static("v"));
        }
        assert!(validate_response_headers(&count).is_err());

        let names = (0..9).map(|index| format!("x-{index}")).collect::<Vec<_>>();
        let name_bytes = names.iter().map(String::len).sum::<usize>();
        let target_values = PLUGIN_HTTP_HEADER_BYTES_MAX - name_bytes;
        let base = target_values / names.len();
        let extra = target_values % names.len();
        let mut exact = HeaderMap::new();
        for (index, name) in names.iter().enumerate() {
            let length = base + usize::from(index < extra);
            assert!(length <= PLUGIN_HTTP_HEADER_VALUE_BYTES_MAX);
            exact.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_bytes(&vec![b'a'; length]).unwrap(),
            );
        }
        assert_eq!(validate_response_headers(&exact).unwrap(), Vec::new());
        let first = exact.get_mut("x-0").unwrap();
        let mut bytes = first.as_bytes().to_vec();
        bytes.push(b'a');
        *first = HeaderValue::from_bytes(&bytes).unwrap();
        assert!(validate_response_headers(&exact).is_err());
    }

    #[test]
    fn permit_is_monotonic_and_first_validation_failure_spends_it() {
        let mut permit = DispatchingHttpPermit::after_durable_transition();
        assert!(!permit.is_spent());
        permit.spend().unwrap();
        assert!(permit.is_spent());
        let error = permit.spend().unwrap_err();
        assert_error(
            error,
            HttpErrorCode::PermissionDenied,
            DeliveryState::NotSent,
        );

        let mut permit = DispatchingHttpPermit::after_durable_transition();
        permit.spend().unwrap();
        let invalid = validate(
            request(GuestMethod::Get, "http://api.example.com", "/"),
            &grant(&["http://api.example.com"], &[GrantedHttpMethod::Get]),
        );
        assert!(invalid.is_err());
        assert!(permit.is_spent());
    }

    #[tokio::test]
    async fn public_transport_spends_permit_before_validation_and_second_call_never_resolves() {
        let transport = PluginHttpTransport::new();
        let grant = grant(&["https://api.example.com"], &[GrantedHttpMethod::Get]);
        let mut permit = DispatchingHttpPermit::after_durable_transition();
        let first = transport
            .request(
                &mut permit,
                &grant,
                request(GuestMethod::Get, "http://api.example.com", "/"),
                "delivery-1",
            )
            .await
            .unwrap_err();
        assert_error(first, HttpErrorCode::InvalidRequest, DeliveryState::NotSent);
        assert!(permit.is_spent());

        let second = transport
            .request(
                &mut permit,
                &grant,
                request(GuestMethod::Get, "https://api.example.com", "/"),
                "delivery-1",
            )
            .await
            .unwrap_err();
        assert_error(
            second,
            HttpErrorCode::PermissionDenied,
            DeliveryState::NotSent,
        );
    }

    #[test]
    fn delivery_identity_is_nonempty_bounded_visible_ascii() {
        assert!(validate_request_headers(&[], "d").is_ok());
        assert!(
            validate_request_headers(&[], &"d".repeat(PLUGIN_HTTP_DELIVERY_ID_BYTES_MAX),).is_ok()
        );
        for invalid in [
            String::new(),
            " d".to_owned(),
            "d ".to_owned(),
            "d\nvalue".to_owned(),
            "d".repeat(PLUGIN_HTTP_DELIVERY_ID_BYTES_MAX + 1),
        ] {
            assert!(validate_request_headers(&[], &invalid).is_err());
        }
    }

    #[test]
    fn public_address_policy_rejects_special_ipv4_and_ipv6_ranges() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.9",
            "192.0.2.1",
            "192.31.196.1",
            "192.52.193.1",
            "192.88.99.1",
            "192.168.0.1",
            "192.175.48.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "::8.8.8.8",
            "64:ff9b::808:808",
            "64:ff9b:1::1",
            "100::1",
            "2001::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:0808:0808::1",
            "2620:4f:8000::1",
            "3ffe::1",
            "3fff::1",
            "5f00::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
        ] {
            let address: IpAddr = address.parse().unwrap();
            assert!(!is_public_destination(address), "{address}");
        }
        for address in ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"] {
            let address: IpAddr = address.parse().unwrap();
            assert!(is_public_destination(address), "{address}");
        }
    }

    #[test]
    fn all_dns_answers_are_checked_and_exactly_one_is_pinned() {
        let public_a: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let public_b: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let private: SocketAddr = "127.0.0.1:443".parse().unwrap();
        let pinned = pin_destination("api.example.com", 443, &[public_a, public_b]).unwrap();
        assert_eq!(pinned.host, "api.example.com");
        assert_eq!(pinned.address, public_a);
        assert!(pin_destination("api.example.com", 443, &[public_a, private]).is_err());
        assert!(pin_destination("api.example.com", 443, &[]).is_err());
        assert!(pin_destination("api.example.com", 8443, &[public_a]).is_err());
        assert!(
            pin_destination(
                "api.example.com",
                443,
                &vec![public_a; PLUGIN_HTTP_DNS_ANSWERS_MAX + 1],
            )
            .is_err()
        );
    }

    #[test]
    fn scoped_ipv6_and_rebinding_answers_fail_closed_without_re_resolution() {
        let scoped = SocketAddr::V6(std::net::SocketAddrV6::new(
            "2606:4700:4700::1111".parse().unwrap(),
            443,
            0,
            2,
        ));
        assert!(pin_destination("api.example.com", 443, &[scoped]).is_err());

        let first: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let rebound: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let denied: SocketAddr = "169.254.169.254:443".parse().unwrap();
        let first_pin = pin_destination("api.example.com", 443, &[first]).unwrap();
        let second_pin = pin_destination("api.example.com", 443, &[rebound]).unwrap();
        assert_eq!(first_pin.address, first);
        assert_eq!(second_pin.address, rebound);
        assert!(pin_destination("api.example.com", 443, &[denied]).is_err());
    }

    #[test]
    fn pinned_client_and_request_preserve_original_host_and_transport_headers() {
        let grant = grant(&["https://api.example.com"], &[GrantedHttpMethod::Post]);
        let mut input = request(GuestMethod::Post, "https://api.example.com", "/submit");
        input.headers = vec![HttpHeader {
            name: "content-type".to_owned(),
            value: "application/json".to_owned(),
        }];
        input.body = ByteList::new(b"{}".to_vec()).unwrap();
        let validated = ValidatedRequest::new(&grant, input, "delivery-1").unwrap();
        let destination = pin_destination(
            "api.example.com",
            443,
            &["93.184.216.34:443".parse().unwrap()],
        )
        .unwrap();
        let client = build_pinned_client(&destination).unwrap();
        let built = validated.build(&client).unwrap();
        assert_eq!(built.url().host_str(), Some("api.example.com"));
        assert_eq!(built.url().scheme(), "https");
        assert_eq!(built.headers().get(ACCEPT_ENCODING).unwrap(), "identity");
        assert_eq!(
            built.headers().get(DELIVERY_ID_HEADER).unwrap(),
            "delivery-1"
        );
        assert!(built.headers().get("host").is_none());
        assert!(built.headers().get("content-length").is_none());
        assert_eq!(PLUGIN_HTTP_DEADLINE, Duration::from_secs(5));
    }

    #[test]
    fn response_body_streaming_keeps_only_one_mebibyte_and_one_byte_proof() {
        let mut exact = BoundedResponseBody::new(Some(PLUGIN_HTTP_BODY_BYTES_MAX as u64));
        assert!(!exact.push(&vec![b'a'; PLUGIN_HTTP_BODY_BYTES_MAX / 2]));
        assert!(!exact.push(&vec![b'b'; PLUGIN_HTTP_BODY_BYTES_MAX / 2]));
        assert_eq!(exact.bytes.len(), PLUGIN_HTTP_BODY_BYTES_MAX);
        assert!(!exact.truncated);

        assert!(exact.push(b"x"));
        assert_eq!(exact.bytes.len(), PLUGIN_HTTP_BODY_BYTES_MAX);
        assert!(exact.truncated);

        let mut oversized_chunk = BoundedResponseBody::new(None);
        assert!(oversized_chunk.push(&vec![b'z'; PLUGIN_HTTP_BODY_BYTES_MAX + 1]));
        assert_eq!(oversized_chunk.bytes.len(), PLUGIN_HTTP_BODY_BYTES_MAX);
    }

    #[test]
    fn classification_is_conservative_stable_redacted_and_never_retryable() {
        let cases = [
            (
                FailureKind::Timeout,
                TransportProgress::NotSent,
                HttpErrorCode::Timeout,
                DeliveryState::NotSent,
            ),
            (
                FailureKind::Timeout,
                TransportProgress::ResponseReceived,
                HttpErrorCode::Timeout,
                DeliveryState::ResponseReceived,
            ),
            (
                FailureKind::Tls,
                TransportProgress::NotSent,
                HttpErrorCode::TlsFailed,
                DeliveryState::NotSent,
            ),
            (
                FailureKind::Connect,
                TransportProgress::NotSent,
                HttpErrorCode::ConnectFailed,
                DeliveryState::NotSent,
            ),
            (
                FailureKind::Ambiguous,
                TransportProgress::MayHaveBeenSent,
                HttpErrorCode::DeliveryAmbiguous,
                DeliveryState::MayHaveBeenSent,
            ),
            (
                FailureKind::Unavailable,
                TransportProgress::ResponseReceived,
                HttpErrorCode::Unavailable,
                DeliveryState::ResponseReceived,
            ),
        ];
        for (kind, progress, code, delivery) in cases {
            assert_error(classified_error(kind, progress), code, delivery);
        }
        assert_error(
            deadline_error(TransportProgress::MayHaveBeenSent),
            HttpErrorCode::DeliveryAmbiguous,
            DeliveryState::MayHaveBeenSent,
        );
        assert_error(
            deadline_error(TransportProgress::ResponseReceived),
            HttpErrorCode::Timeout,
            DeliveryState::ResponseReceived,
        );
        assert_error(
            invalid_response(),
            HttpErrorCode::InvalidResponse,
            DeliveryState::ResponseReceived,
        );
        assert_error(
            dns_denied(),
            HttpErrorCode::DnsDenied,
            DeliveryState::NotSent,
        );
    }

    #[test]
    fn non_success_and_redirect_statuses_remain_normal_response_values() {
        for status in [200_u16, 301, 404, 500] {
            let response = HttpResponse {
                status,
                headers: Vec::new(),
                body: ByteList::new(Vec::new()).unwrap(),
                truncated: false,
            };
            assert_eq!(response.status, status);
        }
    }
}
