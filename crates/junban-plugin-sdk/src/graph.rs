use std::collections::{BTreeMap, BTreeSet};

use semver::{Version, VersionReq};
use thiserror::Error;

use crate::{manifest::RuntimeManifest, util::decode_hex_32};

pub const GRAPH_NODES_MAX: usize = 64;
pub const GRAPH_DEPTH_MAX: usize = 16;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MissingDependency {
    pub plugin_id: String,
    pub dependency_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IncompatibleDependency {
    pub plugin_id: String,
    pub dependency_id: String,
    pub requirement: String,
    pub installed_version: String,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum GraphError {
    #[error("plugin graph exceeds the node ceiling")]
    TooManyNodes,
    #[error("plugin graph contains duplicate plugin ids")]
    DuplicatePlugin,
    #[error("plugin graph contains self dependencies")]
    SelfDependency,
    #[error("plugin graph contains duplicate dependencies")]
    DuplicateDependency,
    #[error("plugin graph references a missing dependency service")]
    MissingService,
    #[error("plugin graph exceeds the dependency fanout ceiling")]
    Fanout,
    #[error("installed package authority is invalid")]
    InvalidPackageAuthority,
    #[error("plugin graph has unresolved dependencies")]
    UnresolvedDependencies {
        missing: Vec<MissingDependency>,
        incompatible: Vec<IncompatibleDependency>,
    },
    #[error("plugin graph contains a dependency cycle")]
    Cycle,
    #[error("plugin graph exceeds the depth ceiling")]
    Depth,
    #[error("dependency lock does not match installed authority")]
    LockMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedGraph {
    pub activation_order: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DependencyLock {
    pub plugin_id: String,
    pub dependency_id: String,
    pub version_requirement: String,
    pub resolved_version: String,
    pub dependency_package_generation: u64,
    pub dependency_package_sha256: String,
}

#[derive(Clone, Debug)]
pub struct InstalledPackage<'a> {
    pub manifest: &'a RuntimeManifest,
    pub package_generation: u64,
    pub package_sha256: &'a str,
}

pub fn validate_dependency_graph(
    packages: &[InstalledPackage<'_>],
) -> Result<ValidatedGraph, GraphError> {
    if packages.len() > GRAPH_NODES_MAX {
        return Err(GraphError::TooManyNodes);
    }
    let mut nodes = BTreeMap::new();
    for package in packages {
        if package.manifest.dependencies.len() > crate::manifest::PLUGIN_DEPENDENCIES_MAX {
            return Err(GraphError::Fanout);
        }
        if package.package_generation == 0
            || decode_hex_32(package.package_sha256, "package_sha256").is_err()
        {
            return Err(GraphError::InvalidPackageAuthority);
        }
        if nodes
            .insert(package.manifest.id.as_str(), package)
            .is_some()
        {
            return Err(GraphError::DuplicatePlugin);
        }
    }
    for package in packages {
        let mut dependency_ids = BTreeSet::new();
        for dependency in &package.manifest.dependencies {
            if dependency.id == package.manifest.id {
                return Err(GraphError::SelfDependency);
            }
            if !dependency_ids.insert(dependency.id.as_str()) {
                return Err(GraphError::DuplicateDependency);
            }
        }
        if package.manifest.validate().is_err() {
            return Err(GraphError::InvalidPackageAuthority);
        }
    }

    let mut missing = Vec::new();
    let mut incompatible = Vec::new();
    for package in packages {
        for dependency in &package.manifest.dependencies {
            let Some(installed) = nodes.get(dependency.id.as_str()) else {
                missing.push(MissingDependency {
                    plugin_id: package.manifest.id.clone(),
                    dependency_id: dependency.id.clone(),
                });
                continue;
            };
            let requirement = VersionReq::parse(&dependency.requirement)
                .map_err(|_| GraphError::InvalidPackageAuthority)?;
            let version = Version::parse(&installed.manifest.version)
                .map_err(|_| GraphError::InvalidPackageAuthority)?;
            if !requirement.matches(&version) {
                incompatible.push(IncompatibleDependency {
                    plugin_id: package.manifest.id.clone(),
                    dependency_id: dependency.id.clone(),
                    requirement: dependency.requirement.clone(),
                    installed_version: installed.manifest.version.clone(),
                });
            }
            if dependency.services.iter().any(|service_id| {
                !installed
                    .manifest
                    .services
                    .iter()
                    .any(|service| service.id == *service_id)
            }) {
                return Err(GraphError::MissingService);
            }
        }
    }
    if !missing.is_empty() || !incompatible.is_empty() {
        missing.sort_by(|left, right| {
            (&left.plugin_id, &left.dependency_id).cmp(&(&right.plugin_id, &right.dependency_id))
        });
        incompatible.sort_by(|left, right| {
            (&left.plugin_id, &left.dependency_id).cmp(&(&right.plugin_id, &right.dependency_id))
        });
        return Err(GraphError::UnresolvedDependencies {
            missing,
            incompatible,
        });
    }

    for id in nodes.keys() {
        depth(id, &nodes, &mut BTreeSet::new(), &mut BTreeMap::new())?;
    }

    let mut remaining: BTreeMap<&str, BTreeSet<&str>> = packages
        .iter()
        .map(|package| {
            (
                package.manifest.id.as_str(),
                package
                    .manifest
                    .dependencies
                    .iter()
                    .map(|dependency| dependency.id.as_str())
                    .collect(),
            )
        })
        .collect();
    let mut ready: BTreeSet<&str> = remaining
        .iter()
        .filter_map(|(id, dependencies)| dependencies.is_empty().then_some(*id))
        .collect();
    let mut order = Vec::with_capacity(packages.len());
    while let Some(id) = ready.pop_first() {
        if remaining.remove(id).is_none() {
            continue;
        }
        order.push(id.to_owned());
        for (dependent, dependencies) in &mut remaining {
            dependencies.remove(id);
            if dependencies.is_empty() {
                ready.insert(dependent);
            }
        }
    }
    if !remaining.is_empty() {
        return Err(GraphError::Cycle);
    }
    Ok(ValidatedGraph {
        activation_order: order,
    })
}

fn depth<'a>(
    id: &'a str,
    nodes: &BTreeMap<&'a str, &InstalledPackage<'a>>,
    visiting: &mut BTreeSet<&'a str>,
    memo: &mut BTreeMap<&'a str, usize>,
) -> Result<usize, GraphError> {
    if let Some(value) = memo.get(id) {
        return Ok(*value);
    }
    if !visiting.insert(id) {
        return Err(GraphError::Cycle);
    }
    let mut result = 1;
    if let Some(package) = nodes.get(id) {
        for dependency in &package.manifest.dependencies {
            result = result.max(1 + depth(&dependency.id, nodes, visiting, memo)?);
        }
    }
    visiting.remove(id);
    if result > GRAPH_DEPTH_MAX {
        return Err(GraphError::Depth);
    }
    memo.insert(id, result);
    Ok(result)
}

pub fn validate_dependency_locks(
    packages: &[InstalledPackage<'_>],
    locks: &[DependencyLock],
) -> Result<(), GraphError> {
    validate_dependency_graph(packages)?;
    let nodes: BTreeMap<&str, &InstalledPackage<'_>> = packages
        .iter()
        .map(|package| (package.manifest.id.as_str(), package))
        .collect();
    let expected_count: usize = packages
        .iter()
        .map(|package| package.manifest.dependencies.len())
        .sum();
    if locks.len() != expected_count {
        return Err(GraphError::LockMismatch);
    }
    let mut previous: Option<(&str, &str)> = None;
    for lock in locks {
        let key = (lock.plugin_id.as_str(), lock.dependency_id.as_str());
        if previous.is_some_and(|old| old >= key) {
            return Err(GraphError::LockMismatch);
        }
        let package = nodes
            .get(lock.plugin_id.as_str())
            .ok_or(GraphError::LockMismatch)?;
        let dependency = package
            .manifest
            .dependencies
            .iter()
            .find(|dependency| dependency.id == lock.dependency_id)
            .ok_or(GraphError::LockMismatch)?;
        let resolved = nodes
            .get(lock.dependency_id.as_str())
            .ok_or(GraphError::LockMismatch)?;
        if lock.version_requirement != dependency.requirement
            || lock.resolved_version != resolved.manifest.version
            || lock.dependency_package_generation != resolved.package_generation
            || lock.dependency_package_sha256 != resolved.package_sha256
            || decode_hex_32(&lock.dependency_package_sha256, "dependency_package_sha256").is_err()
        {
            return Err(GraphError::LockMismatch);
        }
        previous = Some(key);
    }
    Ok(())
}
