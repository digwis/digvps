//! Serde models mirroring `src/shared/vps.ts` and `src/shared/projects.ts`.
//! All fields serialize in camelCase to match the renderer contract.

use serde::{Deserialize, Serialize};

fn opt_is_none<T>(v: &Option<T>) -> bool {
    v.is_none()
}

// ---------- vps ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VpsConnectionInput {
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub location_label: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub auth_type: String, // "password" | "privateKey"
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub passphrase: Option<String>,
    /// Internal: connection source (manual | ssh-config | known-hosts)
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub source: Option<String>,
}

fn default_port() -> u16 {
    22
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpsConnectionRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub location_label: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub expires_at: Option<String>,
    pub auth_type: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub source: Option<String>,
    pub status: String, // idle | connected | failed
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_connected_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHostCandidate {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub source: String, // "known-hosts"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigCandidate {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub source: String, // "ssh-config"
    pub config_path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub identity_file_path: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub private_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigMutationInput {
    pub config_path: String,
    #[serde(default)]
    pub original_name: Option<String>,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub identity_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSshConfigFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: u64,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub server_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeySetupResult {
    pub ok: bool,
    pub key_path: String,
    pub public_key_path: String,
    pub config_path: String,
    pub private_key: String,
    pub public_key: String,
    pub created: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFilePermissions {
    pub octal: String,
    pub symbolic: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String, // file | directory | symlink
    pub size: u64,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileBrowseResult {
    pub current_path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub parent_path: Option<String>,
    pub root_path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub focused_path: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub focused_type: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub transport: Option<String>,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileReadResult {
    pub path: String,
    pub content: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileStatResult {
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub modified_at: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub real_path: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub permissions: Option<RemoteFilePermissions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFileMutationResult {
    pub ok: bool,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrashEntry {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub trashed_path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: u64,
    pub deleted_at: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrashListResult {
    pub root_path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub transport: Option<String>,
    pub entries: Vec<RemoteTrashEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileUploadResult {
    pub ok: bool,
    pub uploaded_count: u32,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileDownloadInput {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePackageStatus {
    pub name: String,
    pub id: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub version: Option<String>,
    pub command: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub port_hint: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub systemd_unit: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub running: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetric {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionTelemetry {
    pub cpu_percent: f64,
    pub cpu_iowait_percent: f64,
    pub cpu_steal_percent: f64,
    pub memory_percent: f64,
    pub disk_percent: f64,
    pub inode_percent: f64,
    pub load_percent: f64,
    pub net_down_bps: f64,
    pub net_up_bps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectionPortCheck {
    pub label: String,
    pub port: u32,
    pub listening: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionReachabilityCheck {
    pub label: String,
    pub url: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub status_code: Option<u16>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub response_time_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteServiceStatus {
    pub unit: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpsInspection {
    pub connection_id: String,
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub uptime: String,
    pub working_directory: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub package_manager: Option<String>,
    pub metrics: Vec<SystemMetric>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub telemetry: Option<InspectionTelemetry>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub port_checks: Option<Vec<InspectionPortCheck>>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub reachability_checks: Option<Vec<InspectionReachabilityCheck>>,
    pub packages: Vec<RemotePackageStatus>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub services: Option<Vec<RemoteServiceStatus>>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitcoinPrice {
    pub usd: f64,
    pub cny: f64,
    pub usd_24h_change: f64,
    pub cny_24h_change: f64,
    pub last_updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUpgradeCheckResult {
    pub supported: bool,
    pub manager: String, // apt | apt-get | none
    pub upgradable_count: u32,
    pub index_refreshed: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUpgradeApplyResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub likely_rebooting: Option<bool>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub likely_interrupted: Option<bool>,
    pub stdout: String,
    pub message: String,
}

// ---------- terminal ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateInput {
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteInput {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeInput {
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalErrorEvent {
    pub session_id: String,
    pub message: String,
}

// ---------- projects ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectRecord {
    pub id: String,
    pub display_name: String,
    pub local_path: String,
    pub category: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_remote_path: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_deploy_at: Option<String>,
    pub last_deploy_status: String, // none | success | failed | running
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_deploy_message: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_deploy_kind: Option<String>, // sftp | local-npm-script
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectInput {
    pub local_path: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldInput {
    pub display_name: String,
    pub slug: String,
    pub local_path: String,
    pub package_manager: String, // "pnpm"
    pub monorepo: bool,
    pub template: String, // next-core | next-payload | next-directus
    pub database: String, // postgresql | sqlite
    #[serde(default)]
    pub client_targets: Vec<String>,
    #[serde(default)]
    pub runtime_modules: Vec<String>,
    #[serde(default)]
    pub service_modules: Vec<String>,
    #[serde(default)]
    pub auto_install: Option<bool>,
    #[serde(default)]
    pub auto_start: Option<bool>,
    #[serde(default)]
    pub full_template_pull: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuntimeModulesUpdateInput {
    pub project_id: String,
    pub runtime_modules: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldBootstrapHealthCheck {
    pub name: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldBootstrap {
    pub attempted: bool,
    pub install_ok: bool,
    pub start_ok: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub preview_url: Option<String>,
    pub health_checks: Vec<ProjectScaffoldBootstrapHealthCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldProgressEvent {
    pub stage: String,
    pub status: String, // running | success | warning | error
    pub percent: u32,
    pub message: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub detail: Option<String>,
    pub local_path: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub project_id: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DigwisProjectAppContract {
    pub path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub dev_command: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub build_command: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub start_command: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DigwisProjectServiceContract {
    pub enabled: bool,
    pub path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub dev_command: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    #[serde(rename = "type")]
    pub service_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DigwisProjectApps {
    pub web: DigwisProjectAppContract,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub desktop: Option<DigwisProjectAppContract>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub mobile_ios: Option<DigwisProjectAppContract>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub mobile_android: Option<DigwisProjectAppContract>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DigwisProjectServices {
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub cms: Option<DigwisProjectServiceContract>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub python_ai: Option<DigwisProjectServiceContract>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub python_data: Option<DigwisProjectServiceContract>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub go_worker: Option<DigwisProjectServiceContract>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub rust_worker: Option<DigwisProjectServiceContract>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DigwisProjectPanel {
    pub preview_url: String,
    pub admin_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigwisProjectConfig {
    pub version: u32,
    pub project_type: String,
    pub template: String,
    pub package_manager: String,
    pub monorepo: bool,
    pub database: String,
    pub client_targets: Vec<String>,
    pub runtime_modules: Vec<String>,
    pub service_modules: Vec<String>,
    pub apps: DigwisProjectApps,
    pub services: DigwisProjectServices,
    pub panel: DigwisProjectPanel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldResult {
    pub ok: bool,
    pub message: String,
    pub project: LocalProjectRecord,
    pub local_path: String,
    pub created_files: Vec<String>,
    pub warnings: Vec<String>,
    pub contract: DigwisProjectConfig,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub bootstrap: Option<ProjectScaffoldBootstrap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuntimeModulesUpdateResult {
    pub ok: bool,
    pub message: String,
    pub contract: DigwisProjectConfig,
    pub created_files: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLocalPreview {
    pub url: String,
    pub web_path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub admin_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLocalDevStartResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub pid: Option<u32>,
    pub preview_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLocalAdminStartResult {
    pub ok: bool,
    pub message: String,
    pub admin_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUrlReachabilityResult {
    pub ok: bool,
    pub detail: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub final_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClientAppInput {
    pub project_id: String,
    pub target: String, // electron | ios-native | android-native
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClientAppOpenResult {
    pub ok: bool,
    pub target: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClientAppStartResult {
    pub ok: bool,
    pub message: String,
    pub target: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClientAppIdeOpenResult {
    pub ok: bool,
    pub target: String,
    pub path: String,
    pub application: String, // "Xcode" | "Android Studio"
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLocalPathUpdateInput {
    pub project_id: String,
    pub local_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteInput {
    pub project_id: String,
    #[serde(default)]
    pub remove_local_directory: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteResult {
    pub success: bool,
    pub removed_local_directory: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPanelDeploySection {
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub strategy: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub script: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub remote_app_dir: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub remote_service: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub public_check_url: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPanelInitSection {
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub remote_packages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub env_template: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub systemd_unit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPanelDeployConfig {
    pub version: u32,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub deploy: Option<ProjectPanelDeploySection>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub init: Option<ProjectPanelInitSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeployProfile {
    pub npm_scripts: Vec<String>,
    pub recommended_strategy: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub recommended_npm_script: Option<String>,
    pub can_initialize: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub config_path: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub config_error: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub default_remote_app_dir: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub default_remote_service: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub default_public_check_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoteStateInput {
    pub project_id: String,
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoteState {
    pub can_initialize: bool,
    pub ready: bool,
    pub missing_items: Vec<String>,
    pub runtime_issues: Vec<String>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoteFileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoteServiceStatus {
    pub configured: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub unit: Option<String>,
    pub active: bool,
    pub enabled: bool,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoteSiteStatus {
    pub mode: String, // none | port | domain
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub preview_port: Option<u32>,
    pub ssl_enabled: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub ssl_mode: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub custom_certificate_configured: Option<bool>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub certificate_pem: Option<String>,
    pub nginx_installed: bool,
    pub certbot_installed: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub config_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoteDetailsInput {
    pub project_id: String,
    pub connection_id: String,
    #[serde(default)]
    pub browse_path: Option<String>,
    #[serde(default)]
    pub force_refresh: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoteDetails {
    pub remote_app_dir: String,
    pub current_path: String,
    pub path_exists: bool,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub app_port: Option<u32>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub preview_url: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub public_url: Option<String>,
    pub files: Vec<ProjectRemoteFileEntry>,
    pub service: ProjectRemoteServiceStatus,
    pub site: ProjectRemoteSiteStatus,
    pub checked_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSiteSettingsInput {
    pub project_id: String,
    pub connection_id: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub ssl_email: Option<String>,
    #[serde(default)]
    pub certificate_pem: Option<String>,
    #[serde(default)]
    pub private_key_pem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSiteSettingsResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub preview_url: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub public_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeployInput {
    pub project_id: String,
    pub connection_id: String,
    #[serde(default)]
    pub strategy: Option<String>,
    #[serde(default)]
    pub npm_script: Option<String>,
    #[serde(default)]
    pub remote_parent_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInitializeInput {
    pub project_id: String,
    pub connection_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEnvInput {
    pub project_id: String,
    pub connection_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEnvUpdateInput {
    pub project_id: String,
    pub connection_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEnvResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeployResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub remote_path: Option<String>,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeployLogEvent {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub script: Option<String>,
    pub stream: String, // stdout | stderr | system
    pub chunk: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOperationLogEntry {
    pub id: String,
    pub project_id: String,
    pub stream: String,
    pub chunk: String,
    pub at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOperationLogAppendInput {
    pub project_id: String,
    pub stream: String,
    pub chunk: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOperationLogListInput {
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteManagedProject {
    pub id: String,
    pub connection_id: String,
    pub domain: String,
    pub nginx_config_path: String,
    pub proxy_target: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub project_path: Option<String>,
    pub path_source: String, // systemd | pm2 | docker | heuristic | unknown
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub service_name: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub runtime_type: Option<String>,
    pub status: String, // ok | warning | unknown
    pub status_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteManagedProjectScanInput {
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteManagedProjectScanResult {
    pub connection_id: String,
    pub projects: Vec<RemoteManagedProject>,
    pub scanned_at: String,
}

// ---------- action hints / migration ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActionHint {
    pub action: String, // code | data | uploads
    pub needs_attention: bool,
    pub reason: String,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub local_changed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActionHints {
    pub project_id: String,
    pub checked_at: String,
    pub hints: Vec<ProjectActionHint>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMigrationInput {
    pub project_id: String,
    pub source_connection_id: String,
    pub target_connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMigrationResult {
    pub ok: bool,
    pub message: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub target_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "opt_is_none")]
    pub target_remote_path: Option<String>,
    pub source_disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOperationResult {
    pub ok: bool,
    pub message: String,
    pub duration_ms: u64,
}
