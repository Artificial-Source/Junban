#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

/*
 * Benchmark-only fixed-origin interception. The immutable OpenAI hostname is
 * resolved to a dedicated loopback sentinel. Only connect(2) calls for that
 * exact sentinel on HTTPS port 443 are redirected to the ephemeral high-port
 * fixture. Every other hostname, address, and port delegates unchanged.
 */
#define FIXTURE_HOST "api.openai.com"
#define FIXTURE_SENTINEL "127.66.0.1"
#define FIXTURE_SENTINEL_U32 0x7f420001U
#define FIXTURE_PORT_ENV "JUNBAN_PHASE6_FIXTURE_PORT"

typedef int (*getaddrinfo_fn)(const char *, const char *,
                              const struct addrinfo *, struct addrinfo **);
typedef int (*connect_fn)(int, const struct sockaddr *, socklen_t);

static getaddrinfo_fn load_getaddrinfo(void) {
    return (getaddrinfo_fn)dlsym(RTLD_NEXT, "getaddrinfo");
}

static connect_fn load_connect(void) {
    return (connect_fn)dlsym(RTLD_NEXT, "connect");
}

static int fixture_port(in_port_t *result) {
    const char *raw = getenv(FIXTURE_PORT_ENV);
    const char *cursor;
    char *end = NULL;
    unsigned long parsed;

    if (raw == NULL || raw[0] == '\0') {
        return -1;
    }
    for (cursor = raw; *cursor != '\0'; cursor++) {
        if (*cursor < '0' || *cursor > '9') {
            return -1;
        }
    }
    errno = 0;
    parsed = strtoul(raw, &end, 10);
    if (errno != 0 || end == raw || *end != '\0' || parsed <= 1023UL ||
        parsed > 65535UL) {
        return -1;
    }
    *result = htons((in_port_t)parsed);
    return 0;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **result) {
    getaddrinfo_fn real_getaddrinfo = load_getaddrinfo();
    if (real_getaddrinfo == NULL) {
        return EAI_SYSTEM;
    }
    if (node != NULL && strcmp(node, FIXTURE_HOST) == 0) {
        return real_getaddrinfo(FIXTURE_SENTINEL, service, hints, result);
    }
    return real_getaddrinfo(node, service, hints, result);
}

int connect(int socket_fd, const struct sockaddr *address, socklen_t length) {
    connect_fn real_connect = load_connect();
    const struct sockaddr_in *original;
    struct sockaddr_in redirected;
    in_port_t port;

    if (real_connect == NULL) {
        errno = ENOSYS;
        return -1;
    }
    if (address == NULL || length < (socklen_t)sizeof(struct sockaddr_in) ||
        address->sa_family != AF_INET) {
        return real_connect(socket_fd, address, length);
    }
    original = (const struct sockaddr_in *)address;
    if (ntohl(original->sin_addr.s_addr) != FIXTURE_SENTINEL_U32 ||
        ntohs(original->sin_port) != 443U) {
        return real_connect(socket_fd, address, length);
    }
    if (fixture_port(&port) != 0) {
        errno = ECONNREFUSED;
        return -1;
    }
    redirected = *original;
    redirected.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    redirected.sin_port = port;
    return real_connect(socket_fd, (const struct sockaddr *)&redirected,
                        (socklen_t)sizeof(redirected));
}
