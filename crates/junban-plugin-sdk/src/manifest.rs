use std::{collections::BTreeSet, net::IpAddr, str::FromStr};

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

use crate::{
    error::{Result, SdkError},
    permission::{PERMISSIONS_MAX, permission_set_hash, scope_hash},
    util::{decode_hex_32, is_canonical_id, validate_sorted_unique, validate_visible},
};

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const MANIFEST_BYTES_MAX: usize = 65_536;
pub const PLUGIN_DEPENDENCIES_MAX: usize = 16;
pub const COMMANDS_MAX: usize = 32;
pub const SUBSCRIPTIONS_MAX: usize = 32;
pub const SURFACES_MAX: usize = 16;
pub const SETTINGS_MAX: usize = 64;
pub const SERVICES_MAX: usize = 16;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub publisher: Publisher,
    pub license: String,
    pub junban_compatibility: String,
    pub wit: WitAuthority,
    pub runtime_profile: RuntimeProfile,
    pub component_sha256: String,
    pub permissions: Vec<Permission>,
    pub dependencies: Vec<Dependency>,
    pub commands: Vec<CommandDeclaration>,
    pub subscriptions: Vec<EventKind>,
    pub surfaces: Vec<SurfaceDeclaration>,
    pub settings: Vec<SettingDeclaration>,
    pub services: Vec<ServiceDeclaration>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Publisher {
    pub id: String,
    pub name: String,
    pub key_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WitAuthority {
    pub package: String,
    pub world: String,
    pub version: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeProfile {
    Rust,
    Typescript,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Capability {
    #[serde(rename = "tasks:read")]
    TasksRead,
    #[serde(rename = "tasks:write")]
    TasksWrite,
    #[serde(rename = "projects:read")]
    ProjectsRead,
    #[serde(rename = "projects:write")]
    ProjectsWrite,
    #[serde(rename = "tags:read")]
    TagsRead,
    #[serde(rename = "tags:write")]
    TagsWrite,
    #[serde(rename = "events:subscribe")]
    EventsSubscribe,
    #[serde(rename = "settings")]
    Settings,
    #[serde(rename = "storage")]
    Storage,
    #[serde(rename = "commands")]
    Commands,
    #[serde(rename = "ui:view")]
    UiView,
    #[serde(rename = "ui:panel")]
    UiPanel,
    #[serde(rename = "ui:status")]
    UiStatus,
    #[serde(rename = "services:provide")]
    ServicesProvide,
    #[serde(rename = "services:consume")]
    ServicesConsume,
    #[serde(rename = "http")]
    Http,
    #[serde(rename = "logging")]
    Logging,
}

impl Capability {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TasksRead => "tasks:read",
            Self::TasksWrite => "tasks:write",
            Self::ProjectsRead => "projects:read",
            Self::ProjectsWrite => "projects:write",
            Self::TagsRead => "tags:read",
            Self::TagsWrite => "tags:write",
            Self::EventsSubscribe => "events:subscribe",
            Self::Settings => "settings",
            Self::Storage => "storage",
            Self::Commands => "commands",
            Self::UiView => "ui:view",
            Self::UiPanel => "ui:panel",
            Self::UiStatus => "ui:status",
            Self::ServicesProvide => "services:provide",
            Self::ServicesConsume => "services:consume",
            Self::Http => "http",
            Self::Logging => "logging",
        }
    }

    const fn is_unscoped(self) -> bool {
        !matches!(
            self,
            Self::EventsSubscribe | Self::ServicesConsume | Self::Http
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Permission {
    pub capability: Capability,
    pub scope: PermissionScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PermissionScope {
    Unscoped(UnscopedPermission),
    Events(EventScope),
    Services(ServiceConsumeScope),
    Http(HttpScope),
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UnscopedPermission {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventScope {
    pub event_kinds: Vec<EventKind>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceConsumeScope {
    pub services: Vec<ServiceReference>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceReference {
    pub plugin_id: String,
    pub service_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HttpScope {
    pub origins: Vec<HttpOrigin>,
    pub methods: Vec<HttpMethod>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct HttpOrigin(pub String);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum HttpMethod {
    #[serde(rename = "DELETE")]
    Delete,
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "PATCH")]
    Patch,
    #[serde(rename = "POST")]
    Post,
    #[serde(rename = "PUT")]
    Put,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub id: String,
    pub requirement: String,
    pub services: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommandDeclaration {
    pub id: String,
    pub title: String,
    pub description: String,
    pub icon: Option<String>,
    pub inputs: Vec<InputField>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InputField {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: DataKind,
    pub required: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataKind {
    String,
    Integer,
    Boolean,
    Date,
    Timestamp,
    TaskId,
    ProjectId,
    TagId,
    PluginId,
    OptionId,
    StringList,
    IntegerList,
    BooleanList,
    DateList,
    TimestampList,
    TaskIdList,
    ProjectIdList,
    TagIdList,
    PluginIdList,
    OptionIdList,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    TaskCreated,
    TaskUpdated,
    TaskCompleted,
    TaskUncompleted,
    TaskCancelled,
    TaskReopened,
    TaskDeleted,
    ProjectCreated,
    ProjectUpdated,
    ProjectDeleted,
    TagCreated,
    TagUpdated,
    TagDeleted,
    SectionCreated,
    SectionUpdated,
    SectionDeleted,
}

impl EventKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TaskCreated => "task-created",
            Self::TaskUpdated => "task-updated",
            Self::TaskCompleted => "task-completed",
            Self::TaskUncompleted => "task-uncompleted",
            Self::TaskCancelled => "task-cancelled",
            Self::TaskReopened => "task-reopened",
            Self::TaskDeleted => "task-deleted",
            Self::ProjectCreated => "project-created",
            Self::ProjectUpdated => "project-updated",
            Self::ProjectDeleted => "project-deleted",
            Self::TagCreated => "tag-created",
            Self::TagUpdated => "tag-updated",
            Self::TagDeleted => "tag-deleted",
            Self::SectionCreated => "section-created",
            Self::SectionUpdated => "section-updated",
            Self::SectionDeleted => "section-deleted",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceKind {
    View,
    Panel,
    Status,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceLocation {
    Navigation,
    Tools,
    Workspace,
    Sidebar,
    Status,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceDeclaration {
    pub id: String,
    pub kind: SurfaceKind,
    pub title: String,
    pub icon: Option<String>,
    pub location: SurfaceLocation,
    pub actions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SettingDeclaration {
    pub id: String,
    pub label: String,
    pub description: String,
    pub schema: SettingSchema,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum SettingSchema {
    Text {
        default: String,
        min_bytes: u16,
        max_bytes: u16,
        secret: bool,
    },
    Integer {
        default: i64,
        min: i64,
        max: i64,
        step: i64,
    },
    Boolean {
        default: bool,
    },
    Select {
        default: String,
        options: Vec<SettingOption>,
    },
}

/// Canonical scalar persisted for one non-secret manifest setting.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(untagged)]
pub enum SettingValue {
    Text(String),
    Integer(i64),
    Boolean(bool),
}

impl SettingSchema {
    /// Validate one SQLite-persistable value against this exact schema.
    /// Secret text declarations deliberately have no SQLite representation.
    pub fn validate_persisted_value(&self, value: &SettingValue) -> Result<()> {
        match (self, value) {
            (
                Self::Text {
                    min_bytes,
                    max_bytes,
                    secret: false,
                    ..
                },
                SettingValue::Text(value),
            ) if value.len() >= usize::from(*min_bytes)
                && value.len() <= usize::from(*max_bytes)
                && validate_visible(value, 0, usize::from(*max_bytes), true, "settings.value")
                    .is_ok() =>
            {
                Ok(())
            }
            (Self::Integer { min, max, step, .. }, SettingValue::Integer(value))
                if *step > 0
                    && value >= min
                    && value <= max
                    && (i128::from(*value) - i128::from(*min)) % i128::from(*step) == 0 =>
            {
                Ok(())
            }
            (Self::Boolean { .. }, SettingValue::Boolean(_)) => Ok(()),
            (Self::Select { options, .. }, SettingValue::Text(value))
                if options.iter().any(|option| option.id == *value) =>
            {
                Ok(())
            }
            _ => Err(SdkError::Manifest { field: "settings" }),
        }
    }
}

impl RuntimeManifest {
    /// Validate one persisted setting key/value through the manifest authority.
    pub fn validate_persisted_setting(&self, key: &str, value: &SettingValue) -> Result<()> {
        let declaration = self
            .settings
            .iter()
            .find(|declaration| declaration.id == key)
            .ok_or(SdkError::Manifest { field: "settings" })?;
        declaration.schema.validate_persisted_value(value)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SettingOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceDeclaration {
    pub id: String,
    pub title: String,
    pub request: Vec<ServiceField>,
    pub response: Vec<ServiceField>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceField {
    pub id: String,
    pub kind: DataKind,
    pub required: bool,
}

impl RuntimeManifest {
    pub fn parse_canonical(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MANIFEST_BYTES_MAX {
            return Err(SdkError::Length { field: "manifest" });
        }
        let manifest: Self = serde_json::from_slice(bytes).map_err(|_| SdkError::CanonicalJson)?;
        manifest.validate()?;
        let canonical = serde_json::to_vec(&manifest).map_err(|_| SdkError::CanonicalJson)?;
        if canonical != bytes {
            return Err(SdkError::CanonicalJson);
        }
        Ok(manifest)
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| SdkError::CanonicalJson)?;
        if bytes.len() > MANIFEST_BYTES_MAX {
            return Err(SdkError::Length { field: "manifest" });
        }
        Ok(bytes)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(SdkError::Manifest {
                field: "schema_version",
            });
        }
        validate_id(&self.id, "id")?;
        validate_visible(&self.name, 1, 128, false, "name")?;
        validate_visible(&self.description, 0, 512, true, "description")?;
        validate_version(&self.version, "version")?;
        validate_id(&self.publisher.id, "publisher.id")?;
        validate_visible(&self.publisher.name, 1, 128, false, "publisher.name")?;
        decode_hex_32(&self.publisher.key_id, "publisher.key_id")?;
        if self.license.len() > 128
            || self.license.is_empty()
            || !self.license.is_ascii()
            || spdx::Expression::parse(&self.license).is_err()
        {
            return Err(SdkError::Manifest { field: "license" });
        }
        validate_requirement(&self.junban_compatibility, "junban_compatibility")?;
        if self.wit.package != "junban:plugin"
            || self.wit.world != "plugin"
            || self.wit.version != "0.1.0"
        {
            return Err(SdkError::Manifest { field: "wit" });
        }
        decode_hex_32(&self.component_sha256, "component_sha256")?;
        self.validate_permissions()?;
        self.validate_dependencies()?;
        self.validate_commands()?;
        self.validate_subscriptions()?;
        self.validate_surfaces()?;
        self.validate_settings()?;
        self.validate_services()?;
        self.validate_capability_matrix()?;
        Ok(())
    }

    #[must_use]
    pub fn requested_capabilities(&self) -> BTreeSet<Capability> {
        self.permissions
            .iter()
            .map(|permission| permission.capability)
            .collect()
    }

    pub fn permission_hash(&self) -> Result<[u8; 32]> {
        permission_set_hash(&self.permissions)
    }

    fn validate_permissions(&self) -> Result<()> {
        if self.permissions.len() > PERMISSIONS_MAX {
            return Err(SdkError::Manifest {
                field: "permissions",
            });
        }
        let mut previous: Option<(&str, [u8; 32])> = None;
        let mut capabilities = BTreeSet::new();
        for permission in &self.permissions {
            validate_permission(permission)?;
            let key = (permission.capability.as_str(), scope_hash(permission)?);
            if previous.is_some_and(|value| value >= key)
                || !capabilities.insert(permission.capability)
            {
                return Err(SdkError::Order {
                    field: "permissions",
                });
            }
            previous = Some(key);
        }
        Ok(())
    }

    fn validate_dependencies(&self) -> Result<()> {
        if self.dependencies.len() > PLUGIN_DEPENDENCIES_MAX {
            return Err(SdkError::Manifest {
                field: "dependencies",
            });
        }
        validate_ids_sorted(
            self.dependencies.iter().map(|value| value.id.as_str()),
            "dependencies",
        )?;
        for dependency in &self.dependencies {
            validate_id(&dependency.id, "dependencies.id")?;
            if dependency.id == self.id {
                return Err(SdkError::Graph {
                    kind: "self dependency",
                });
            }
            validate_requirement(&dependency.requirement, "dependencies.requirement")?;
            if dependency.services.len() > SERVICES_MAX {
                return Err(SdkError::Manifest {
                    field: "dependencies.services",
                });
            }
            validate_sorted_unique(&dependency.services, "dependencies.services")?;
            for service in &dependency.services {
                validate_id(service, "dependencies.services")?;
            }
        }
        Ok(())
    }

    fn validate_commands(&self) -> Result<()> {
        if self.commands.len() > COMMANDS_MAX {
            return Err(SdkError::Manifest { field: "commands" });
        }
        validate_ids_sorted(
            self.commands.iter().map(|value| value.id.as_str()),
            "commands",
        )?;
        for command in &self.commands {
            validate_id(&command.id, "commands.id")?;
            validate_visible(&command.title, 1, 128, false, "commands.title")?;
            validate_visible(&command.description, 0, 512, true, "commands.description")?;
            validate_icon(command.icon.as_deref())?;
            if command.inputs.len() > 32 {
                return Err(SdkError::Manifest {
                    field: "commands.inputs",
                });
            }
            validate_ids_sorted(
                command.inputs.iter().map(|value| value.id.as_str()),
                "commands.inputs",
            )?;
            for input in &command.inputs {
                validate_id(&input.id, "commands.inputs.id")?;
                validate_visible(&input.label, 1, 128, false, "commands.inputs.label")?;
                validate_visible(
                    &input.description,
                    0,
                    512,
                    true,
                    "commands.inputs.description",
                )?;
            }
        }
        Ok(())
    }

    fn validate_subscriptions(&self) -> Result<()> {
        if self.subscriptions.len() > SUBSCRIPTIONS_MAX {
            return Err(SdkError::Manifest {
                field: "subscriptions",
            });
        }
        validate_sorted_unique(&self.subscriptions, "subscriptions")
    }

    fn validate_surfaces(&self) -> Result<()> {
        if self.surfaces.len() > SURFACES_MAX {
            return Err(SdkError::Manifest { field: "surfaces" });
        }
        validate_ids_sorted(
            self.surfaces.iter().map(|value| value.id.as_str()),
            "surfaces",
        )?;
        for surface in &self.surfaces {
            validate_id(&surface.id, "surfaces.id")?;
            validate_visible(&surface.title, 1, 128, false, "surfaces.title")?;
            validate_icon(surface.icon.as_deref())?;
            let location_matches = matches!(
                (surface.kind, surface.location),
                (
                    SurfaceKind::View,
                    SurfaceLocation::Navigation
                        | SurfaceLocation::Tools
                        | SurfaceLocation::Workspace
                ) | (SurfaceKind::Panel, SurfaceLocation::Sidebar)
                    | (SurfaceKind::Status, SurfaceLocation::Status)
            );
            if !location_matches || surface.actions.len() > 32 {
                return Err(SdkError::Manifest {
                    field: "surfaces.location",
                });
            }
            validate_sorted_unique(&surface.actions, "surfaces.actions")?;
            for action in &surface.actions {
                validate_id(action, "surfaces.actions")?;
            }
        }
        Ok(())
    }

    fn validate_settings(&self) -> Result<()> {
        if self.settings.len() > SETTINGS_MAX {
            return Err(SdkError::Manifest { field: "settings" });
        }
        validate_ids_sorted(
            self.settings.iter().map(|value| value.id.as_str()),
            "settings",
        )?;
        let mut aggregate = 0_usize;
        for setting in &self.settings {
            validate_id(&setting.id, "settings.id")?;
            validate_visible(&setting.label, 1, 128, false, "settings.label")?;
            validate_visible(&setting.description, 0, 512, true, "settings.description")?;
            match &setting.schema {
                SettingSchema::Text {
                    default,
                    min_bytes,
                    max_bytes,
                    secret,
                } => {
                    if *secret
                        || min_bytes > max_bytes
                        || *max_bytes > 8_192
                        || default.len() < usize::from(*min_bytes)
                        || default.len() > usize::from(*max_bytes)
                    {
                        return Err(SdkError::Manifest {
                            field: "settings.text",
                        });
                    }
                    validate_visible(default, 0, 8_192, true, "settings.default")?;
                    aggregate = aggregate
                        .checked_add(default.len())
                        .ok_or(SdkError::Length { field: "settings" })?;
                }
                SettingSchema::Integer {
                    default,
                    min,
                    max,
                    step,
                } => {
                    if min > max
                        || default < min
                        || default > max
                        || *step <= 0
                        || default
                            .checked_sub(*min)
                            .is_none_or(|delta| delta % step != 0)
                    {
                        return Err(SdkError::Manifest {
                            field: "settings.integer",
                        });
                    }
                    aggregate += 8;
                }
                SettingSchema::Boolean { .. } => aggregate += 1,
                SettingSchema::Select { default, options } => {
                    if options.is_empty() || options.len() > 32 {
                        return Err(SdkError::Manifest {
                            field: "settings.options",
                        });
                    }
                    validate_ids_sorted(
                        options.iter().map(|value| value.id.as_str()),
                        "settings.options",
                    )?;
                    for option in options {
                        validate_id(&option.id, "settings.options.id")?;
                        validate_visible(&option.label, 1, 128, false, "settings.options.label")?;
                    }
                    if !options.iter().any(|option| option.id == *default) {
                        return Err(SdkError::Manifest {
                            field: "settings.default",
                        });
                    }
                    aggregate = aggregate
                        .checked_add(default.len())
                        .ok_or(SdkError::Length { field: "settings" })?;
                }
            }
        }
        if aggregate > 65_536 {
            return Err(SdkError::Length { field: "settings" });
        }
        Ok(())
    }

    fn validate_services(&self) -> Result<()> {
        if self.services.len() > SERVICES_MAX {
            return Err(SdkError::Manifest { field: "services" });
        }
        validate_ids_sorted(
            self.services.iter().map(|value| value.id.as_str()),
            "services",
        )?;
        for service in &self.services {
            validate_id(&service.id, "services.id")?;
            validate_visible(&service.title, 1, 128, false, "services.title")?;
            validate_service_fields(&service.request)?;
            validate_service_fields(&service.response)?;
        }
        Ok(())
    }

    fn validate_capability_matrix(&self) -> Result<()> {
        let capabilities = self.requested_capabilities();
        if !self.commands.is_empty() && !capabilities.contains(&Capability::Commands) {
            return Err(SdkError::Permission);
        }
        match self
            .permissions
            .iter()
            .find(|permission| permission.capability == Capability::EventsSubscribe)
        {
            Some(Permission {
                scope: PermissionScope::Events(scope),
                ..
            }) if !self.subscriptions.is_empty() && scope.event_kinds == self.subscriptions => {}
            None if self.subscriptions.is_empty() => {}
            _ => return Err(SdkError::Permission),
        }
        for surface in &self.surfaces {
            let required = match surface.kind {
                SurfaceKind::View => Capability::UiView,
                SurfaceKind::Panel => Capability::UiPanel,
                SurfaceKind::Status => Capability::UiStatus,
            };
            if !capabilities.contains(&required) {
                return Err(SdkError::Permission);
            }
        }
        if !self.settings.is_empty() && !capabilities.contains(&Capability::Settings) {
            return Err(SdkError::Permission);
        }
        if !self.services.is_empty() && !capabilities.contains(&Capability::ServicesProvide) {
            return Err(SdkError::Permission);
        }
        let expected_services: Vec<ServiceReference> = self
            .dependencies
            .iter()
            .flat_map(|dependency| {
                dependency
                    .services
                    .iter()
                    .map(|service_id| ServiceReference {
                        plugin_id: dependency.id.clone(),
                        service_id: service_id.clone(),
                    })
            })
            .collect();
        match self
            .permissions
            .iter()
            .find(|permission| permission.capability == Capability::ServicesConsume)
        {
            Some(Permission {
                scope: PermissionScope::Services(scope),
                ..
            }) if !expected_services.is_empty() && scope.services == expected_services => {}
            None if expected_services.is_empty() => {}
            _ => return Err(SdkError::Permission),
        }
        Ok(())
    }
}

pub(crate) fn validate_permission(permission: &Permission) -> Result<()> {
    match (&permission.capability, &permission.scope) {
        (capability, PermissionScope::Unscoped(_)) if capability.is_unscoped() => Ok(()),
        (Capability::EventsSubscribe, PermissionScope::Events(scope)) => {
            if scope.event_kinds.is_empty() || scope.event_kinds.len() > 32 {
                return Err(SdkError::Permission);
            }
            validate_sorted_unique(&scope.event_kinds, "permissions.events")
        }
        (Capability::ServicesConsume, PermissionScope::Services(scope)) => {
            if scope.services.is_empty() || scope.services.len() > 256 {
                return Err(SdkError::Permission);
            }
            validate_sorted_unique(&scope.services, "permissions.services")?;
            for service in &scope.services {
                validate_id(&service.plugin_id, "permissions.services.plugin_id")?;
                validate_id(&service.service_id, "permissions.services.service_id")?;
            }
            Ok(())
        }
        (Capability::Http, PermissionScope::Http(scope)) => {
            if scope.origins.is_empty() || scope.origins.len() > 16 || scope.methods.is_empty() {
                return Err(SdkError::Permission);
            }
            validate_sorted_unique(&scope.origins, "permissions.http.origins")?;
            validate_sorted_unique(&scope.methods, "permissions.http.methods")?;
            for origin in &scope.origins {
                validate_origin(&origin.0)?;
            }
            Ok(())
        }
        _ => Err(SdkError::Permission),
    }
}

fn validate_id(value: &str, field: &'static str) -> Result<()> {
    if is_canonical_id(value) {
        Ok(())
    } else {
        Err(SdkError::Manifest { field })
    }
}

fn validate_version(value: &str, field: &'static str) -> Result<()> {
    if value.is_empty() || value.len() > 64 {
        return Err(SdkError::Manifest { field });
    }
    let parsed = Version::parse(value).map_err(|_| SdkError::Manifest { field })?;
    if parsed.to_string() != value {
        return Err(SdkError::Manifest { field });
    }
    Ok(())
}

fn validate_requirement(value: &str, field: &'static str) -> Result<()> {
    if value.is_empty() || value.len() > 128 || !value.is_ascii() {
        return Err(SdkError::Manifest { field });
    }
    let parsed = VersionReq::parse(value).map_err(|_| SdkError::Manifest { field })?;
    if parsed.to_string() != value {
        return Err(SdkError::Manifest { field });
    }
    Ok(())
}

fn validate_origin(value: &str) -> Result<()> {
    if value.len() > 272 {
        return Err(SdkError::Manifest {
            field: "permissions.http.origin",
        });
    }
    let authority = value.strip_prefix("https://").ok_or(SdkError::Manifest {
        field: "permissions.http.origin",
    })?;
    if authority.is_empty()
        || !authority.is_ascii()
        || authority != authority.to_ascii_lowercase()
        || authority.ends_with('.')
        || authority.contains(['/', '?', '#', '@', '[', ']'])
    {
        return Err(SdkError::Manifest {
            field: "permissions.http.origin",
        });
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let parsed = port.parse::<u16>().map_err(|_| SdkError::Manifest {
                field: "permissions.http.origin",
            })?;
            if parsed == 0 || parsed == 443 || port.starts_with('0') {
                return Err(SdkError::Manifest {
                    field: "permissions.http.origin",
                });
            }
            (host, Some(parsed))
        }
        None => (authority, None),
    };
    let _ = port;
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || IpAddr::from_str(host).is_ok()
        || host.len() > 253
        || !host.contains('.')
    {
        return Err(SdkError::Manifest {
            field: "permissions.http.origin",
        });
    }
    if host.split('.').any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        return Err(SdkError::Manifest {
            field: "permissions.http.origin",
        });
    }
    Ok(())
}

fn validate_icon(icon: Option<&str>) -> Result<()> {
    const ICONS: &[&str] = &[
        "bolt", "calendar", "check", "clock", "code", "folder", "list", "play", "tag", "timer",
    ];
    if icon.is_some_and(|value| ICONS.binary_search(&value).is_err()) {
        return Err(SdkError::Manifest { field: "icon" });
    }
    Ok(())
}

fn validate_service_fields(fields: &[ServiceField]) -> Result<()> {
    if fields.len() > 32 {
        return Err(SdkError::Manifest {
            field: "services.fields",
        });
    }
    validate_ids_sorted(
        fields.iter().map(|value| value.id.as_str()),
        "services.fields",
    )?;
    for field in fields {
        validate_id(&field.id, "services.fields.id")?;
    }
    Ok(())
}

fn validate_ids_sorted<'a>(
    values: impl IntoIterator<Item = &'a str>,
    field: &'static str,
) -> Result<()> {
    let mut previous = None;
    for value in values {
        if previous.is_some_and(|old| old >= value) {
            return Err(SdkError::Order { field });
        }
        previous = Some(value);
    }
    Ok(())
}
