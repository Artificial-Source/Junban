use crate::manifest::{Capability, SurfaceKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImportAuthority {
    pub interface: &'static str,
    pub capability: Option<Capability>,
}

pub const IMPORT_AUTHORITIES: &[ImportAuthority] = &[
    ImportAuthority {
        interface: "junban:plugin/types@0.1.0",
        capability: None,
    },
    ImportAuthority {
        interface: "junban:plugin/host-clock@0.1.0",
        capability: None,
    },
    ImportAuthority {
        interface: "junban:plugin/host-http@0.1.0",
        capability: Some(Capability::Http),
    },
    ImportAuthority {
        interface: "junban:plugin/host-log@0.1.0",
        capability: Some(Capability::Logging),
    },
    ImportAuthority {
        interface: "junban:plugin/host-projects@0.1.0",
        capability: Some(Capability::ProjectsRead),
    },
    ImportAuthority {
        interface: "junban:plugin/host-services@0.1.0",
        capability: Some(Capability::ServicesConsume),
    },
    ImportAuthority {
        interface: "junban:plugin/host-settings@0.1.0",
        capability: Some(Capability::Settings),
    },
    ImportAuthority {
        interface: "junban:plugin/host-storage@0.1.0",
        capability: Some(Capability::Storage),
    },
    ImportAuthority {
        interface: "junban:plugin/host-tags@0.1.0",
        capability: Some(Capability::TagsRead),
    },
    ImportAuthority {
        interface: "junban:plugin/host-tasks@0.1.0",
        capability: Some(Capability::TasksRead),
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeclarationKind {
    Command,
    Event,
    Surface(SurfaceKind),
    Setting,
    Service,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeclarationAuthority {
    pub kind: DeclarationKind,
    pub capability: Capability,
}

pub const DECLARATION_AUTHORITIES: &[DeclarationAuthority] = &[
    DeclarationAuthority {
        kind: DeclarationKind::Command,
        capability: Capability::Commands,
    },
    DeclarationAuthority {
        kind: DeclarationKind::Event,
        capability: Capability::EventsSubscribe,
    },
    DeclarationAuthority {
        kind: DeclarationKind::Surface(SurfaceKind::View),
        capability: Capability::UiView,
    },
    DeclarationAuthority {
        kind: DeclarationKind::Surface(SurfaceKind::Panel),
        capability: Capability::UiPanel,
    },
    DeclarationAuthority {
        kind: DeclarationKind::Surface(SurfaceKind::Status),
        capability: Capability::UiStatus,
    },
    DeclarationAuthority {
        kind: DeclarationKind::Setting,
        capability: Capability::Settings,
    },
    DeclarationAuthority {
        kind: DeclarationKind::Service,
        capability: Capability::ServicesProvide,
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutcomeKind {
    CreateTask,
    PatchTask,
    CompleteTask,
    UncompleteTask,
    CancelTask,
    ReopenTask,
    DeleteTask,
    BulkTasks,
    CreateProject,
    PatchProject,
    DeleteProject,
    CreateTag,
    PatchTag,
    DeleteTag,
    KvPatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutcomeAuthority {
    pub kind: OutcomeKind,
    pub capability: Capability,
}

pub const OUTCOME_AUTHORITIES: &[OutcomeAuthority] = &[
    OutcomeAuthority {
        kind: OutcomeKind::CreateTask,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::PatchTask,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::CompleteTask,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::UncompleteTask,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::CancelTask,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::ReopenTask,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::DeleteTask,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::BulkTasks,
        capability: Capability::TasksWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::CreateProject,
        capability: Capability::ProjectsWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::PatchProject,
        capability: Capability::ProjectsWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::DeleteProject,
        capability: Capability::ProjectsWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::CreateTag,
        capability: Capability::TagsWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::PatchTag,
        capability: Capability::TagsWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::DeleteTag,
        capability: Capability::TagsWrite,
    },
    OutcomeAuthority {
        kind: OutcomeKind::KvPatch,
        capability: Capability::Storage,
    },
];

pub fn import_authority(interface: &str) -> Option<ImportAuthority> {
    IMPORT_AUTHORITIES
        .iter()
        .copied()
        .find(|authority| authority.interface == interface)
}

pub const fn declaration_authority(kind: DeclarationKind) -> DeclarationAuthority {
    let capability = match kind {
        DeclarationKind::Command => Capability::Commands,
        DeclarationKind::Event => Capability::EventsSubscribe,
        DeclarationKind::Surface(SurfaceKind::View) => Capability::UiView,
        DeclarationKind::Surface(SurfaceKind::Panel) => Capability::UiPanel,
        DeclarationKind::Surface(SurfaceKind::Status) => Capability::UiStatus,
        DeclarationKind::Setting => Capability::Settings,
        DeclarationKind::Service => Capability::ServicesProvide,
    };
    DeclarationAuthority { kind, capability }
}

pub const fn outcome_authority(kind: OutcomeKind) -> OutcomeAuthority {
    let capability = match kind {
        OutcomeKind::CreateTask
        | OutcomeKind::PatchTask
        | OutcomeKind::CompleteTask
        | OutcomeKind::UncompleteTask
        | OutcomeKind::CancelTask
        | OutcomeKind::ReopenTask
        | OutcomeKind::DeleteTask
        | OutcomeKind::BulkTasks => Capability::TasksWrite,
        OutcomeKind::CreateProject | OutcomeKind::PatchProject | OutcomeKind::DeleteProject => {
            Capability::ProjectsWrite
        }
        OutcomeKind::CreateTag | OutcomeKind::PatchTag | OutcomeKind::DeleteTag => {
            Capability::TagsWrite
        }
        OutcomeKind::KvPatch => Capability::Storage,
    };
    OutcomeAuthority { kind, capability }
}
