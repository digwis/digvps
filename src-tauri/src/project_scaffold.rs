//! Project scaffold — port of project-scaffold.ts.
//! Generated file contents come from `src-tauri/scaffold-templates/*.tmpl`,
//! extracted verbatim from the TypeScript template literals (see
//! scripts/extract-scaffold-templates.cjs). `${expr}` markers inside templates
//! are substituted here, preserving the original output byte-for-byte.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use crate::error::{internal_error, AppResult};
use crate::models::*;
use crate::project_local::*;
use crate::scaffold_templates::tmpl;
use crate::util::*;

const DEFAULT_PAYLOAD_PUBLISHED_VERSION: &str = "3.84.1";
const DEFAULT_WEB_PORT: u16 = 3000;
const MAX_WEB_PORT: u16 = 3999;
const LIGHT_RUNTIME_MODULES: &[&str] = &["docs", "dashboard", "blog", "i18n"];
const DIRECTUS_LOCAL_ADMIN_URL: &str = "http://127.0.0.1:8055/admin";

// ---------- template render engine ----------

/// Unescape TS template-literal escapes present in rawText: `\\` `` \` `` `\$`.
/// Then substitute `${expr}` markers with values (TS interpolation happened
/// after escapes were already literal, and only one `\${` exists in the corpus
/// — `${post.slug}`, which never collides with a real key).
fn render(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('\\') | Some('`') | Some('$') => {
                    out.push(chars.next().unwrap());
                }
                _ => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    let mut result = out;
    let mut pairs: Vec<(&str, &String)> = vars.iter().map(|(k, v)| (*k, v)).collect();
    // replace longest marker first to avoid prefix collisions
    pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    for (key, val) in pairs {
        result = result.replace(&format!("${{{key}}}"), val);
    }
    result
}

macro_rules! r {
    ($name:expr) => {
        render(tmpl($name), &[])
    };
    ($name:expr, $($k:expr => $v:expr),+ $(,)?) => {
        render(tmpl($name), &[$(($k, $v)),+])
    };
}

// ---------- context ----------

pub(crate) struct ScaffoldContext {
    root_path: String,
    project_name: String,
    slug: String,
    template: String,
    database: String,
    web_port: u16,
    client_targets: HashSet<String>,
    runtime_modules: HashSet<String>,
    service_modules: HashSet<String>,
}

fn to_posix_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn build_local_preview_url(port: u16) -> String {
    r!("buildLocalPreviewUrl.0.tmpl", "port" => port.to_string())
}

fn build_local_admin_url(port: u16) -> String {
    r!("buildLocalAdminUrl.0.tmpl", "buildLocalPreviewUrl(port)" => build_local_preview_url(port))
}

fn write_text_file(root: &Path, relative: &str, content: impl AsRef<str>, created: &mut Vec<String>) {
    let absolute = root.join(relative);
    if let Some(dir) = absolute.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&absolute, content.as_ref());
    created.push(relative.to_string());
}

// ---------- contract builders ----------

fn build_client_apps_contract(input: &ProjectScaffoldInput) -> (Option<DigwisProjectAppContract>, Option<DigwisProjectAppContract>, Option<DigwisProjectAppContract>) {
    (
        if input.client_targets.iter().any(|t| t == "electron") {
            Some(DigwisProjectAppContract {
                path: "apps/desktop".into(),
                platform: Some("desktop".into()),
                dev_command: Some("pnpm --filter desktop dev".into()),
                build_command: Some("pnpm --filter desktop build".into()),
                start_command: Some("pnpm --filter desktop start".into()),
                port: None,
            })
        } else {
            None
        },
        if input.client_targets.iter().any(|t| t == "ios-native") {
            Some(DigwisProjectAppContract {
                path: "apps/mobile-ios".into(),
                platform: Some("ios".into()),
                ..Default::default()
            })
        } else {
            None
        },
        if input.client_targets.iter().any(|t| t == "android-native") {
            Some(DigwisProjectAppContract {
                path: "apps/mobile-android".into(),
                platform: Some("android".into()),
                ..Default::default()
            })
        } else {
            None
        },
    )
}

fn service_contract(enabled: bool, path: &str, runtime: &str, dev_command: Option<&str>, ty: Option<&str>) -> DigwisProjectServiceContract {
    DigwisProjectServiceContract {
        enabled,
        path: path.into(),
        runtime: Some(runtime.into()),
        dev_command: dev_command.map(String::from),
        service_type: ty.map(String::from),
    }
}

fn build_contract(input: &ProjectScaffoldInput, web_port: u16) -> DigwisProjectConfig {
    let (desktop, ios, android) = build_client_apps_contract(input);
    let has = |m: &str| input.service_modules.iter().any(|s| s == m);
    DigwisProjectConfig {
        version: 1,
        project_type: "next-platform".into(),
        template: input.template.clone(),
        package_manager: input.package_manager.clone(),
        monorepo: input.monorepo,
        database: input.database.clone(),
        client_targets: input.client_targets.clone(),
        runtime_modules: input.runtime_modules.clone(),
        service_modules: input.service_modules.clone(),
        apps: DigwisProjectApps {
            web: DigwisProjectAppContract {
                path: "apps/web".into(),
                platform: Some("web".into()),
                dev_command: Some("pnpm --filter web dev".into()),
                build_command: Some("pnpm --filter web build".into()),
                start_command: Some("pnpm --filter web start".into()),
                port: Some(web_port),
            },
            desktop,
            mobile_ios: ios,
            mobile_android: android,
        },
        services: DigwisProjectServices {
            cms: match input.template.as_str() {
                "next-payload" => Some(service_contract(true, "apps/web", "node", None, Some("payload"))),
                "next-directus" => Some(service_contract(true, "services/directus", "node", None, Some("directus"))),
                _ => None,
            },
            python_ai: has("python-ai").then(|| service_contract(true, "services/py-ai", "python", Some("python3 -m uvicorn app.main:app --reload --port 8100"), None)),
            python_data: has("python-data").then(|| service_contract(true, "services/py-data", "python", Some("python3 -m uvicorn app.main:app --reload --port 8101"), None)),
            go_worker: has("go-worker").then(|| service_contract(true, "services/go-worker", "go", Some("go run ."), None)),
            rust_worker: has("rust-worker").then(|| service_contract(true, "services/rust-worker", "rust", Some("cargo run"), None)),
        },
        panel: DigwisProjectPanel {
            preview_url: build_local_preview_url(web_port),
            admin_url: if input.template == "next-directus" {
                DIRECTUS_LOCAL_ADMIN_URL.to_string()
            } else {
                build_local_admin_url(web_port)
            },
        },
    }
}

fn build_contract_for_full_payload(input: &ProjectScaffoldInput, web_port: u16) -> DigwisProjectConfig {
    let (desktop, ios, android) = build_client_apps_contract(input);
    let mut c = build_contract(input, web_port);
    c.monorepo = false;
    c.apps.web = DigwisProjectAppContract {
        path: ".".into(),
        platform: Some("web".into()),
        dev_command: Some(format!("pnpm dev -- --hostname 127.0.0.1 --port {web_port}")),
        build_command: Some("pnpm build".into()),
        start_command: Some(format!("pnpm start -- --hostname 127.0.0.1 --port {web_port}")),
        port: Some(web_port),
    };
    c.apps.desktop = desktop;
    c.apps.mobile_ios = ios;
    c.apps.mobile_android = android;
    c.services = DigwisProjectServices {
        cms: Some(service_contract(true, ".", "node", None, Some("payload"))),
        ..Default::default()
    };
    c.panel = DigwisProjectPanel {
        preview_url: build_local_preview_url(web_port),
        admin_url: build_local_admin_url(web_port),
    };
    c
}

fn build_contract_for_full_directus(input: &ProjectScaffoldInput, web_port: u16) -> DigwisProjectConfig {
    let (desktop, ios, android) = build_client_apps_contract(input);
    let mut c = build_contract(input, web_port);
    c.monorepo = false;
    c.apps.web = DigwisProjectAppContract {
        path: "apps/web".into(),
        platform: Some("web".into()),
        dev_command: Some("npm run dev --prefix apps/web".into()),
        build_command: Some("npm run build --prefix apps/web".into()),
        start_command: Some("npm run start --prefix apps/web".into()),
        port: Some(web_port),
    };
    c.apps.desktop = desktop;
    c.apps.mobile_ios = ios;
    c.apps.mobile_android = android;
    c.services = DigwisProjectServices {
        cms: Some(service_contract(true, "services/directus", "node", Some("docker compose up -d"), Some("directus"))),
        ..Default::default()
    };
    c.panel = DigwisProjectPanel {
        preview_url: build_local_preview_url(web_port),
        admin_url: DIRECTUS_LOCAL_ADMIN_URL.to_string(),
    };
    c
}

// ---------- json/text builders (non-template fns) ----------

fn build_workspace_patterns() -> Vec<&'static str> {
    vec!["apps/*", "packages/*", "services/*"]
}

fn add_desktop_scripts(scripts: &mut serde_json::Map<String, serde_json::Value>, client_targets: &[String]) {
    if !client_targets.iter().any(|t| t == "electron") {
        return;
    }
    scripts.insert("desktop:dev".into(), "pnpm --filter desktop dev".into());
    scripts.insert("desktop:start".into(), "pnpm --filter desktop start".into());
    scripts.insert("desktop:build".into(), "pnpm --filter desktop build".into());
}

fn json_string(v: &serde_json::Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default() + "\n"
}

fn build_root_package_json(input: &ProjectScaffoldInput) -> String {
    let mut scripts = serde_json::Map::new();
    scripts.insert("dev".into(), "pnpm --filter web dev".into());
    scripts.insert("build".into(), "pnpm --filter web build".into());
    scripts.insert("start".into(), "pnpm --filter web start".into());
    scripts.insert("lint".into(), "pnpm --filter web lint".into());
    if input.template == "next-payload" {
        scripts.insert("payload:types".into(), "pnpm --filter web generate:types".into());
        scripts.insert("payload:importmap".into(), "pnpm --filter web generate:importmap".into());
    }
    if input.template == "next-directus" {
        scripts.insert("directus:bootstrap".into(), "NAPI_RS_FORCE_WASI=1 pnpm --dir services/directus bootstrap".into());
        scripts.insert("directus:dev".into(), "NAPI_RS_FORCE_WASI=1 pnpm --dir services/directus dev".into());
        scripts.insert("directus:start".into(), "NAPI_RS_FORCE_WASI=1 pnpm --dir services/directus start".into());
    }
    add_desktop_scripts(&mut scripts, &input.client_targets);
    json_string(&serde_json::json!({
        "name": input.slug,
        "private": true,
        "packageManager": "pnpm@10",
        "workspaces": build_workspace_patterns(),
        "scripts": serde_json::Value::Object(scripts),
    }))
}

fn build_directus_full_root_package_json(input: &ProjectScaffoldInput, _web_port: u16) -> String {
    let mut scripts = serde_json::Map::new();
    scripts.insert("dev".into(), "npm run dev --prefix apps/web".into());
    scripts.insert("build".into(), "npm run build --prefix apps/web".into());
    scripts.insert("start".into(), "npm run start --prefix apps/web".into());
    scripts.insert("directus:up".into(), "docker compose -f services/directus/docker-compose.yml --env-file services/directus/.env up -d".into());
    scripts.insert("directus:down".into(), "docker compose -f services/directus/docker-compose.yml --env-file services/directus/.env down".into());
    add_desktop_scripts(&mut scripts, &input.client_targets);
    json_string(&serde_json::json!({
        "name": input.slug,
        "private": true,
        "packageManager": "pnpm@10",
        "workspaces": build_workspace_patterns(),
        "scripts": serde_json::Value::Object(scripts),
    }))
}

fn build_web_package_json(input: &ProjectScaffoldInput, web_port: u16) -> String {
    let has_payload = input.template == "next-payload";
    let mut deps = serde_json::Map::new();
    deps.insert("@digwis/api-client".into(), "workspace:*".into());
    deps.insert("@digwis/core".into(), "workspace:*".into());
    deps.insert("next".into(), "^16.0.0".into());
    deps.insert("react".into(), "^19.2.0".into());
    deps.insert("react-dom".into(), "^19.2.0".into());
    if has_payload {
        deps.insert("@payloadcms/next".into(), "^3.0.0".into());
        deps.insert("@payloadcms/richtext-lexical".into(), "^3.0.0".into());
        deps.insert("@payloadcms/db-postgres".into(), "^3.0.0".into());
        deps.insert("@payloadcms/db-sqlite".into(), "^3.0.0".into());
        deps.insert("payload".into(), "^3.0.0".into());
        deps.insert("sharp".into(), "^0.34.0".into());
    }
    let mut scripts = serde_json::Map::new();
    scripts.insert("dev".into(), "node ./scripts/dev-with-wasm.cjs".into());
    scripts.insert("build".into(), "next build".into());
    scripts.insert(
        "start".into(),
        r!("buildWebPackageJson.0.tmpl", "webPort" => web_port.to_string())
            .trim_end()
            .into(),
    );
    scripts.insert("lint".into(), "next lint".into());
    if has_payload {
        scripts.insert("generate:importmap".into(), "payload generate:importmap".into());
        scripts.insert("generate:types".into(), "payload generate:types".into());
    }
    json_string(&serde_json::json!({
        "name": "web",
        "private": true,
        "scripts": serde_json::Value::Object(scripts),
        "dependencies": serde_json::Value::Object(deps),
        "devDependencies": {
            "@next/swc-wasm-nodejs": "^16.2.6",
            "@types/node": "^24.0.0",
            "@types/react": "^19.2.0",
            "@types/react-dom": "^19.2.0",
            "typescript": "^5.8.0"
        }
    }))
}

fn client_target_label(target: &str) -> &'static str {
    match target {
        "electron" => "Electron desktop client",
        "ios-native" => "Native iOS client",
        _ => "Native Android client",
    }
}

fn build_feature_list(ctx: &ScaffoldContext) -> String {
    let mut features = vec![
        "Next.js app router as the default product shell".to_string(),
        r!("buildFeatureList.0.tmpl",
            "ctx.database === \"postgresql\" ? \"PostgreSQL\" : \"SQLite\"" =>
            if ctx.database == "postgresql" { "PostgreSQL".to_string() } else { "SQLite".to_string() }),
    ];
    if ctx.template == "next-payload" {
        features.push("Payload selected as the CMS contract".to_string());
    }
    if ctx.template == "next-directus" {
        features.push("Directus selected as the CMS contract".to_string());
    }
    if !ctx.client_targets.is_empty() {
        let mut targets: Vec<&String> = ctx.client_targets.iter().collect();
        targets.sort();
        features.push(format!(
            "Client targets: {}",
            r!("buildFeatureList.1.tmpl",
                "Array.from(ctx.clientTargets).map(clientTargetLabel).join(\", \")" =>
                targets.iter().map(|t| client_target_label(t)).collect::<Vec<_>>().join(", "))
        ));
    }
    if !ctx.runtime_modules.is_empty() {
        let mut mods: Vec<&String> = ctx.runtime_modules.iter().collect();
        mods.sort();
        features.push(format!(
            "Runtime modules: {}",
            r!("buildFeatureList.2.tmpl",
                "Array.from(ctx.runtimeModules).join(\", \")" => mods.iter().map(|m| m.as_str()).collect::<Vec<_>>().join(", "))
        ));
    }
    if !ctx.service_modules.is_empty() {
        let mut mods: Vec<&String> = ctx.service_modules.iter().collect();
        mods.sort();
        features.push(format!(
            "Worker services: {}",
            r!("buildFeatureList.3.tmpl",
                "Array.from(ctx.serviceModules).join(\", \")" => mods.iter().map(|m| m.as_str()).collect::<Vec<_>>().join(", "))
        ));
    }
    features
        .iter()
        .map(|item| r!("buildFeatureList.4.tmpl", "item" => item.clone()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_readme(ctx: &ScaffoldContext) -> String {
    let cms_text = match ctx.template.as_str() {
        "next-payload" => "- Payload CMS is wired through `apps/web`\n",
        "next-directus" => "- Directus sidecar lives in `services/directus`\n",
        _ => "",
    }
    .to_string();
    let service_lines = if ctx.service_modules.is_empty() {
        "- none".to_string()
    } else {
        let mut v: Vec<&String> = ctx.service_modules.iter().collect();
        v.sort();
        v.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n")
    };
    let target_lines = if ctx.client_targets.is_empty() {
        "- web only".to_string()
    } else {
        let mut v: Vec<&String> = ctx.client_targets.iter().collect();
        v.sort();
        v.iter()
            .map(|m| format!("- {}", client_target_label(m)))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let payload_steps = if ctx.template == "next-payload" {
        "4. Open `/admin` to finish the first Payload user bootstrap\n5. If you change Payload collection imports, run `pnpm payload:importmap` and `pnpm payload:types`"
    } else {
        ""
    }
    .to_string();
    let directus_steps = if ctx.template == "next-directus" {
        "4. Run `pnpm directus:dev` to start Directus sidecar\n5. Open `http://127.0.0.1:8055/admin` for Directus admin"
    } else {
        ""
    }
    .to_string();
    r!("buildReadme.0.tmpl",
        "ctx.projectName" => ctx.project_name.clone(),
        "ctx.database === \"postgresql\" ? \"PostgreSQL\" : \"SQLite\"" =>
            if ctx.database == "postgresql" { "PostgreSQL".to_string() } else { "SQLite".to_string() },
        "cmsText" => cms_text,
        "ctx.serviceModules.size ? Array.from(ctx.serviceModules).map((item) => `- ${item}`).join(\"\\n\") : \"- none\"" => service_lines,
        "ctx.clientTargets.size ? Array.from(ctx.clientTargets).map((item) => `- ${clientTargetLabel(item)}`).join(\"\\n\") : \"- web only\"" => target_lines,
        "buildLocalPreviewUrl(ctx.webPort)" => build_local_preview_url(ctx.web_port),
        "ctx.template === \"next-payload\" ? \"4. Open `/admin` to finish the first Payload user bootstrap\\n5. If you change Payload collection imports, run `pnpm payload:importmap` and `pnpm payload:types`\" : \"\"" => payload_steps,
        "ctx.template === \"next-directus\" ? \"4. Run `pnpm directus:dev` to start Directus sidecar\\n5. Open `http://127.0.0.1:8055/admin` for Directus admin\" : \"\"" => directus_steps,
    )
}

fn build_runtime_modules_helper(enabled: &[String]) -> String {
    let mut set: Vec<String> = enabled.iter().cloned().collect::<HashSet<_>>().into_iter().collect();
    set.sort();
    r!("buildRuntimeModulesHelper.0.tmpl",
        "JSON.stringify([...new Set(enabledModules)].sort())" => serde_json::to_string(&set).unwrap_or_else(|_| "[]".into()))
}

fn database_url_for(input: &ProjectScaffoldInput, sqlite: &str) -> String {
    if input.database == "postgresql" {
        format!("postgresql://postgres:postgres@127.0.0.1:5432/{}", input.slug)
    } else {
        sqlite.to_string()
    }
}

fn build_root_env_example(input: &ProjectScaffoldInput, web_port: u16) -> String {
    let mut lines = vec![
        format!("DATABASE_URL={}", database_url_for(input, "file:./apps/web/local.db")),
        r!("buildRootEnvExample.2.tmpl", "buildLocalPreviewUrl(webPort)" => build_local_preview_url(web_port))
            .trim_end()
            .to_string(),
    ];
    if input.template == "next-payload" {
        lines.push("PAYLOAD_SECRET=change-me-before-production".to_string());
    }
    if input.template == "next-directus" {
        lines.push("DIRECTUS_URL=http://127.0.0.1:8055".to_string());
    }
    lines.join("\n") + "\n"
}

fn build_web_env_example(input: &ProjectScaffoldInput) -> String {
    let mut lines = vec![format!(
        "DATABASE_URL={}",
        database_url_for(input, "file:./local.db")
    )];
    if input.template == "next-payload" {
        lines.push("PAYLOAD_SECRET=change-me-before-production".to_string());
    }
    if input.template == "next-directus" {
        lines.push("DIRECTUS_URL=http://127.0.0.1:8055".to_string());
    }
    lines.join("\n") + "\n"
}

fn build_directus_service_env_example(input: &ProjectScaffoldInput) -> String {
    let db_client = if input.database == "postgresql" { "pg" } else { "sqlite3" };
    let db_connection = if input.database == "postgresql" {
        format!("postgresql://postgres:postgres@127.0.0.1:5432/{}_directus", input.slug)
    } else {
        "./directus.db".to_string()
    };
    [
        "PORT=8055".to_string(),
        "KEY=change-me-key".to_string(),
        "SECRET=change-me-secret".to_string(),
        format!("DB_CLIENT={db_client}"),
        format!("DB_CONNECTION_STRING={db_connection}"),
        "ADMIN_EMAIL=admin@example.com".to_string(),
        "ADMIN_PASSWORD=change-me-admin-password".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn build_directus_service_package_json() -> String {
    json_string(&serde_json::json!({
        "name": "directus-sidecar",
        "private": true,
        "scripts": {
            "dev": "NAPI_RS_FORCE_WASI=1 directus start",
            "start": "NAPI_RS_FORCE_WASI=1 directus start",
            "bootstrap": "NAPI_RS_FORCE_WASI=1 directus bootstrap"
        },
        "dependencies": {
            "directus": "^11.0.0",
            "@napi-rs/snappy-wasm32-wasi": "7.3.3"
        },
        "optionalDependencies": {
            "@napi-rs/snappy-darwin-arm64": "7.3.3"
        }
    }))
}

fn build_directus_full_docker_compose(input: &ProjectScaffoldInput) -> String {
    let db_service = if input.database == "postgresql" {
        r!("buildDirectusFullDockerCompose.0.tmpl", "input.slug" => input.slug.clone())
    } else {
        tmpl("buildDirectusFullDockerCompose.1.tmpl").to_string()
    };
    let db_env = if input.database == "postgresql" {
        r!("buildDirectusFullDockerCompose.2.tmpl", "input.slug" => input.slug.clone())
    } else {
        tmpl("buildDirectusFullDockerCompose.3.tmpl").to_string()
    };
    r!("buildDirectusFullDockerCompose.4.tmpl",
        "dbService" => db_service,
        "input.database === \"postgresql\" ? \"depends_on:\\n      - directus-db\" : \"\"" =>
            if input.database == "postgresql" { "depends_on:\n      - directus-db".to_string() } else { String::new() },
        "input.database === \"sqlite\" ? \"      - ./database:/directus/database\" : \"\"" =>
            if input.database == "sqlite" { "      - ./database:/directus/database".to_string() } else { String::new() },
        "input.database === \"postgresql\" ? \"  directus_pg:\\n\" : \"\"" =>
            if input.database == "postgresql" { "  directus_pg:\n".to_string() } else { String::new() },
        "dbEnv" => db_env,
    )
}

fn build_directus_full_env(input: &ProjectScaffoldInput) -> String {
    let db_section = if input.database == "postgresql" {
        r!("buildDirectusFullEnv.0.tmpl", "input.slug" => input.slug.clone())
    } else {
        tmpl("buildDirectusFullEnv.1.tmpl").to_string()
    };
    r!("buildDirectusFullEnv.2.tmpl", "dbSection" => db_section)
}

fn build_full_payload_env(input: &ProjectScaffoldInput, secret: &str, web_port: u16) -> String {
    let preview_url = build_local_preview_url(web_port);
    [
        r!("buildFullPayloadEnv.0.tmpl",
            "input.database === \"postgresql\" ? `postgresql://postgres:postgres@127.0.0.1:5432/${input.slug}` : \"file:./local.db\"" =>
            database_url_for(input, "file:./local.db")),
        r!("buildFullPayloadEnv.2.tmpl", "secret" => secret.to_string()),
        r!("buildFullPayloadEnv.3.tmpl", "previewUrl" => preview_url.clone()),
        r!("buildFullPayloadEnv.4.tmpl", "previewUrl" => preview_url),
        r!("buildFullPayloadEnv.5.tmpl", "randomBytes(24).toString(\"hex\")" => random_hex(24)),
        r!("buildFullPayloadEnv.6.tmpl", "randomBytes(24).toString(\"hex\")" => random_hex(24)),
        String::new(),
    ]
    .join("\n")
}

fn random_hex(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn build_payload_config(database: &str) -> String {
    let (adapter_import, adapter) = if database == "postgresql" {
        (
            "import { postgresAdapter } from '@payloadcms/db-postgres'".to_string(),
            r!("buildPayloadConfig.0.tmpl"),
        )
    } else {
        (
            "import { sqliteAdapter } from '@payloadcms/db-sqlite'".to_string(),
            r!("buildPayloadConfig.1.tmpl"),
        )
    };
    r!("buildPayloadConfig.2.tmpl",
        "adapterImport" => adapter_import,
        "adapter" => adapter,
    )
}

fn write_payload_cms_template(database: &str, base_path: &str, mut writer: impl FnMut(&str, &str)) {
    writer(&format!("{base_path}/payload.config.ts"), &build_payload_config(database));
    writer(&format!("{base_path}/collections/Users.ts"), &r!("buildPayloadUsersCollection.0.tmpl"));
    writer(&format!("{base_path}/collections/Media.ts"), &r!("buildPayloadMediaCollection.0.tmpl"));
    writer(&format!("{base_path}/collections/Categories.ts"), &r!("buildPayloadCategoriesCollection.0.tmpl"));
    writer(&format!("{base_path}/collections/Tags.ts"), &r!("buildPayloadTagsCollection.0.tmpl"));
    writer(&format!("{base_path}/collections/Pages.ts"), &payload_pages_collection());
    writer(&format!("{base_path}/collections/Posts.ts"), &payload_posts_collection());
    writer(&format!("{base_path}/globals/SiteSettings.ts"), &payload_site_settings_global());
    writer(&format!("{base_path}/globals/MainNavigationGlobal.ts"), &r!("buildPayloadMainNavigationGlobal.0.tmpl"));
}

fn payload_seo_fields() -> String {
    r!("buildPayloadSeoFields.0.tmpl")
}

fn payload_pages_collection() -> String {
    r!("buildPayloadPagesCollection.0.tmpl", "buildPayloadSeoFields()" => payload_seo_fields())
}

fn payload_posts_collection() -> String {
    r!("buildPayloadPostsCollection.0.tmpl", "buildPayloadSeoFields()" => payload_seo_fields())
}

fn payload_site_settings_global() -> String {
    r!("buildPayloadSiteSettingsGlobal.0.tmpl", "buildPayloadSeoFields()" => payload_seo_fields())
}

// ---------- contract read/write & runtime modules ----------

fn read_project_contract(project_root: &str) -> AppResult<(PathBuf, DigwisProjectConfig)> {
    let contract_path = Path::new(project_root).join("digwis-project.json");
    if !contract_path.exists() {
        return Err(internal_error("项目缺少 digwis-project.json，暂时无法管理模块"));
    }
    let raw = fs::read_to_string(&contract_path).map_err(|e| internal_error(e.to_string()))?;
    let contract = serde_json::from_str(&raw).map_err(|e| internal_error(e.to_string()))?;
    Ok((contract_path, contract))
}

pub fn get_project_config(project_root: &str) -> Option<DigwisProjectConfig> {
    read_project_contract(project_root).ok().map(|(_, c)| c)
}

fn resolve_web_root(project_root: &str, contract: &DigwisProjectConfig) -> PathBuf {
    let web = if contract.apps.web.path.is_empty() { "." } else { &contract.apps.web.path };
    Path::new(project_root).join(web)
}

fn resolve_next_app_dir(web_root: &Path) -> AppResult<PathBuf> {
    for candidate in [web_root.join("app"), web_root.join("src").join("app")] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(internal_error("当前项目还没有可识别的 Next app 目录"))
}

fn resolve_next_lib_dir(web_root: &Path, app_dir: &Path) -> PathBuf {
    let rel = app_dir.strip_prefix(web_root).unwrap_or(app_dir);
    if rel.starts_with("src") {
        web_root.join("src").join("lib")
    } else {
        web_root.join("lib")
    }
}

fn write_file_if_missing(
    absolute: &Path,
    content: &str,
    project_root: &Path,
    created: &mut Vec<String>,
    warnings: &mut Vec<String>,
) {
    let rel = to_posix_path(absolute.strip_prefix(project_root).unwrap_or(absolute));
    if absolute.exists() {
        warnings.push(format!("保留现有文件：{rel}"));
        return;
    }
    if let Some(dir) = absolute.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(absolute, content);
    created.push(rel);
}

fn ensure_runtime_module_scaffold(
    module_id: &str,
    project_root: &Path,
    web_root: &Path,
    enabled_modules: &[String],
    created: &mut Vec<String>,
    warnings: &mut Vec<String>,
) {
    let Ok(app_dir) = resolve_next_app_dir(web_root) else { return };
    let lib_dir = resolve_next_lib_dir(web_root, &app_dir);
    let runtime_path = lib_dir.join("digwis-runtime-modules.ts");
    let runtime_rel = to_posix_path(runtime_path.strip_prefix(project_root).unwrap_or(&runtime_path));
    let existed = runtime_path.exists();
    if let Some(dir) = runtime_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&runtime_path, build_runtime_modules_helper(enabled_modules));
    if !existed && !created.contains(&runtime_rel) {
        created.push(runtime_rel);
    }
    match module_id {
        "dashboard" => write_file_if_missing(
            &app_dir.join("dashboard").join("page.tsx"),
            &r!("buildDashboardModulePage.0.tmpl"),
            project_root,
            created,
            warnings,
        ),
        "docs" => write_file_if_missing(
            &app_dir.join("docs").join("page.tsx"),
            &r!("buildDocsModulePage.0.tmpl"),
            project_root,
            created,
            warnings,
        ),
        "blog" => {
            write_file_if_missing(
                &app_dir.join("blog").join("page.tsx"),
                &r!("buildBlogIndexModulePage.0.tmpl"),
                project_root,
                created,
                warnings,
            );
            write_file_if_missing(
                &app_dir.join("blog").join("[slug]").join("page.tsx"),
                &r!("buildBlogPostModulePage.0.tmpl"),
                project_root,
                created,
                warnings,
            );
        }
        "i18n" => {
            write_file_if_missing(
                &lib_dir.join("digwis-i18n.ts"),
                &r!("buildI18nMessages.0.tmpl"),
                project_root,
                created,
                warnings,
            );
            write_file_if_missing(
                &app_dir.join("[locale]").join("page.tsx"),
                &r!("buildI18nModulePage.0.tmpl"),
                project_root,
                created,
                warnings,
            );
        }
        _ => {}
    }
}

pub fn set_project_runtime_modules(
    project_root: &str,
    next_modules: &[String],
) -> AppResult<ProjectRuntimeModulesUpdateResult> {
    let (contract_path, mut contract) = read_project_contract(project_root)?;
    if contract.project_type != "next-platform" {
        return Err(internal_error("当前项目不是 Digwis 平台项目，无法切换模块"));
    }
    let previous: HashSet<String> = contract.runtime_modules.iter().cloned().collect();
    let normalized: Vec<String> = next_modules
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let normalized_set: HashSet<String> = normalized.iter().cloned().collect();
    let added: Vec<String> = normalized
        .iter()
        .filter(|m| !previous.contains(*m))
        .cloned()
        .collect();
    let unsupported: Vec<String> = added
        .iter()
        .filter(|m| !LIGHT_RUNTIME_MODULES.contains(&m.as_str()))
        .cloned()
        .collect();
    if !unsupported.is_empty() {
        return Err(internal_error(format!(
            "当前版本只支持创建后扩展轻模块：{}；暂不支持 {}",
            LIGHT_RUNTIME_MODULES.join("、"),
            unsupported.join("、")
        )));
    }

    let mut created = Vec::new();
    let mut warnings = Vec::new();
    let web_root = resolve_web_root(project_root, &contract);
    let app_dir = resolve_next_app_dir(&web_root)?;
    let lib_dir = resolve_next_lib_dir(&web_root, &app_dir);
    let runtime_path = lib_dir.join("digwis-runtime-modules.ts");
    if let Some(dir) = runtime_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let runtime_rel = to_posix_path(runtime_path.strip_prefix(Path::new(project_root)).unwrap_or(&runtime_path));
    let existed = runtime_path.exists();
    let _ = fs::write(&runtime_path, build_runtime_modules_helper(&normalized));
    if !existed {
        created.push(runtime_rel);
    }
    for module_id in &added {
        if LIGHT_RUNTIME_MODULES.contains(&module_id.as_str()) {
            ensure_runtime_module_scaffold(
                module_id,
                Path::new(project_root),
                &web_root,
                &normalized,
                &mut created,
                &mut warnings,
            );
        }
    }

    contract.runtime_modules = normalized.clone();
    fs::write(&contract_path, serde_json::to_string_pretty(&contract).unwrap_or_default() + "\n")
        .map_err(|e| internal_error(e.to_string()))?;

    let enabled_light: Vec<String> = normalized
        .iter()
        .filter(|m| LIGHT_RUNTIME_MODULES.contains(&m.as_str()))
        .cloned()
        .collect();
    let disabled_light: Vec<String> = previous
        .iter()
        .filter(|m| LIGHT_RUNTIME_MODULES.contains(&m.as_str()) && !normalized_set.contains(*m))
        .cloned()
        .collect();

    let mut sorted_added = added.clone();
    sorted_added.sort();
    let mut sorted_disabled = disabled_light.clone();
    sorted_disabled.sort();
    let mut parts = Vec::new();
    if !sorted_added.is_empty() {
        parts.push(format!("已启用：{}", sorted_added.join("、")));
    }
    if !sorted_disabled.is_empty() {
        parts.push(format!("已停用：{}", sorted_disabled.join("、")));
    }
    if sorted_added.is_empty() && sorted_disabled.is_empty() {
        parts.push("模块配置未变化".to_string());
    }
    if sorted_added.is_empty() && !enabled_light.is_empty() {
        warnings.push("已存在的模块文件不会被重写。".to_string());
    }

    Ok(ProjectRuntimeModulesUpdateResult {
        ok: true,
        message: if parts.is_empty() { "模块配置已更新".into() } else { parts.join("；") },
        contract,
        created_files: created,
        warnings,
    })
}

// ---------- scaffoldClientTargets ----------

fn scaffold_client_targets(root: &Path, input: &ProjectScaffoldInput, created: &mut Vec<String>, web_port: u16) {
    let project_name = input.display_name.trim().to_string();
    let mut w = |rel: &str, content: String| {
        write_text_file(root, rel, &content, created);
    };

    w("packages/core/README.md", r!("buildSharedCoreReadme.0.tmpl"));
    w("packages/core/package.json", json_string(&serde_json::json!({
        "name": "@digwis/core",
        "private": true,
        "version": "0.0.0",
        "type": "module",
        "main": "./src/index.ts",
        "types": "./src/index.ts"
    })));
    w("packages/core/src/index.ts", r!("buildSharedCoreIndex.0.tmpl"));
    w("packages/api-client/README.md", r!("buildApiClientReadme.0.tmpl"));
    w("packages/api-client/package.json", json_string(&serde_json::json!({
        "name": "@digwis/api-client",
        "private": true,
        "version": "0.0.0",
        "type": "module",
        "main": "./src/index.ts",
        "types": "./src/index.ts"
    })));
    w("packages/api-client/tsconfig.json", build_api_client_tsconfig());
    w("packages/api-client/src/config.ts", r!("buildApiClientConfig.0.tmpl",
        "buildLocalPreviewUrl(webPort)" => build_local_preview_url(web_port)));
    w("packages/api-client/src/contracts.ts", r!("buildApiClientContracts.0.tmpl"));
    w("packages/api-client/src/client.ts", r!("buildApiClientSource.0.tmpl"));
    w("packages/api-client/src/example.ts", r!("buildApiClientExample.0.tmpl"));
    w("packages/api-client/src/index.ts", r!("buildApiClientIndex.0.tmpl"));

    if input.client_targets.iter().any(|t| t == "electron") {
        w("apps/desktop/package.json", build_electron_package_json());
        w("apps/desktop/main.js", r!("buildElectronMain.0.tmpl", "projectName" => project_name.clone()));
        w("apps/desktop/preload.js", r!("buildElectronPreload.0.tmpl"));
        w("apps/desktop/renderer/index.html", r!("buildElectronHtml.0.tmpl", "projectName" => project_name.clone()));
        w("apps/desktop/renderer/renderer.js", r!("buildElectronRendererJs.0.tmpl"));
        w("apps/desktop/renderer/styles.css", r!("buildElectronCss.0.tmpl"));
        w("apps/desktop/README.md", r!("buildElectronReadme.0.tmpl"));
    }

    if input.client_targets.iter().any(|t| t == "ios-native") {
        let scheme = project_name.replace(|c: char| !c.is_alphanumeric(), "");
        let scheme = if scheme.is_empty() { "Digwis".to_string() } else { scheme };
        w("apps/mobile-ios/README.md", r!("buildIosReadme.0.tmpl", "projectName" => project_name.clone()));
        w("apps/mobile-ios/project.yml", r!("buildIosProjectYml.0.tmpl",
            "schemeName" => scheme.clone(),
            "schemeName.toLowerCase()" => scheme.to_lowercase()));
        w("apps/mobile-ios/Sources/App/App.swift", r!("buildIosAppSwift.0.tmpl",
            "projectName.replace(/[^A-Za-z0-9]/g, \"\") || \"Digwis\"" => scheme.clone()));
        w("apps/mobile-ios/Sources/App/ContentView.swift", r!("buildIosContentView.0.tmpl", "projectName" => project_name.clone()));
        w("apps/mobile-ios/Sources/App/AppState.swift", r!("buildIosAppState.0.tmpl",
            "fallbackUrl" => build_local_preview_url(web_port)));
        w("apps/mobile-ios/Sources/App/APIClient.swift", r!("buildIosApiClient.0.tmpl"));
        w("apps/mobile-ios/Resources/Info.plist", r!("buildIosInfoPlist.0.tmpl"));
        w("apps/mobile-ios/Config/API.xcconfig", r!("buildIosApiConfig.0.tmpl",
            "buildLocalPreviewUrl(webPort)" => build_local_preview_url(web_port)));
        w("apps/mobile-ios/Resources/Assets.xcassets/Contents.json", r!("buildAppleAssetsContents.0.tmpl"));
        w("apps/mobile-ios/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json", r!("buildIosAppIconContents.0.tmpl"));
        w("apps/mobile-ios/Resources/Assets.xcassets/AccentColor.colorset/Contents.json", r!("buildIosAccentColorContents.0.tmpl"));
    }

    if input.client_targets.iter().any(|t| t == "android-native") {
        w("apps/mobile-android/README.md", r!("buildAndroidReadme.0.tmpl", "projectName" => project_name.clone()));
        w("apps/mobile-android/settings.gradle.kts", r!("buildAndroidSettingsGradle.0.tmpl"));
        w("apps/mobile-android/build.gradle.kts", r!("buildAndroidRootGradle.0.tmpl"));
        w("apps/mobile-android/gradle.properties", r!("buildAndroidGradleProperties.0.tmpl"));
        w("apps/mobile-android/app/build.gradle.kts", r!("buildAndroidAppGradle.0.tmpl"));
        w("apps/mobile-android/app/proguard-rules.pro", r!("buildAndroidProguardRules.0.tmpl"));
        w("apps/mobile-android/app/src/main/AndroidManifest.xml", r!("buildAndroidManifest.0.tmpl"));
        w("apps/mobile-android/app/src/main/java/com/digwis/mobile/ApiConfig.kt", r!("buildAndroidApiConfig.0.tmpl", "webPort" => web_port.to_string()));
        w("apps/mobile-android/app/src/main/java/com/digwis/mobile/AppState.kt", r!("buildAndroidAppState.0.tmpl"));
        w("apps/mobile-android/app/src/main/java/com/digwis/mobile/MainViewModel.kt", r!("buildAndroidMainViewModel.0.tmpl"));
        w("apps/mobile-android/app/src/main/java/com/digwis/mobile/MainActivity.kt", r!("buildAndroidMainActivity.0.tmpl", "projectName" => project_name.clone()));
        w("apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/DigwisApp.kt", r!("buildAndroidAppComposable.0.tmpl"));
        w("apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/theme/Color.kt", r!("buildAndroidColorScheme.0.tmpl"));
        w("apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/theme/Theme.kt", r!("buildAndroidThemeKt.0.tmpl"));
        w("apps/mobile-android/app/src/main/res/values/strings.xml", r!("buildAndroidStrings.0.tmpl"));
        w("apps/mobile-android/app/src/main/res/values/themes.xml", r!("buildAndroidThemes.0.tmpl"));
    }
}

fn build_api_client_tsconfig() -> String {
    // mirrors buildApiClientTsconfig (plain JSON)
    json_string(&serde_json::json!({
        "compilerOptions": {
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "strict": true,
            "declaration": true,
            "skipLibCheck": true,
            "outDir": "dist"
        },
        "include": ["src"]
    }))
}

fn build_electron_package_json() -> String {
    json_string(&serde_json::json!({
        "name": "digwis-desktop",
        "private": true,
        "version": "0.0.0",
        "main": "main.js",
        "scripts": {
            "dev": "electron .",
            "start": "electron .",
            "build": "electron-builder"
        },
        "devDependencies": {
            "electron": "^32.0.0",
            "electron-builder": "^24.13.3"
        }
    }))
}

// ---------- generateProjectScaffoldFiles ----------

pub fn generate_project_scaffold_files(
    input: &ProjectScaffoldInput,
    root_path: &Path,
    web_port: u16,
) -> (DigwisProjectConfig, Vec<String>) {
    let mut created: Vec<String> = Vec::new();
    let ctx = ScaffoldContext {
        root_path: root_path.to_string_lossy().to_string(),
        project_name: input.display_name.trim().to_string(),
        slug: input.slug.trim().to_string(),
        template: input.template.clone(),
        database: input.database.clone(),
        web_port,
        client_targets: input.client_targets.iter().cloned().collect(),
        runtime_modules: input.runtime_modules.iter().cloned().collect(),
        service_modules: input.service_modules.iter().cloned().collect(),
    };

    macro_rules! w {
        ($rel:expr, $content:expr $(,)?) => {
            write_text_file(root_path, $rel, $content, &mut created)
        };
    }

    w!("package.json", build_root_package_json(input));
    w!(
        "pnpm-workspace.yaml",
        &format!(
            "packages:\n{}\n",
            build_workspace_patterns()
                .iter()
                .map(|i| format!("  - {i}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    );
    w!(".gitignore", "node_modules\n.next\n.env\n.env.local\n.dist\n__pycache__\n.venv\n");
    w!(".env.example", build_root_env_example(input, web_port));
    w!("README.md", build_readme(&ctx));
    w!("apps/web/package.json", build_web_package_json(input, web_port));
    w!("apps/web/.env.example", build_web_env_example(input));
    w!("apps/web/tsconfig.json", build_tsconfig());
    w!(
        "apps/web/next-env.d.ts",
        "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n\n// This file is managed by Next.js.\n",
    );
    w!("apps/web/next.config.mjs", r!("buildNextConfig.0.tmpl"));
    w!(
        "apps/web/scripts/dev-with-wasm.cjs",
        &r!("buildWebDevLauncher.0.tmpl", "webPort" => web_port.to_string()),
    );
    w!("apps/web/app/layout.tsx", r!("buildWebLayout.0.tmpl", "projectName" => ctx.project_name.clone()));
    w!(
        "apps/web/app/page.tsx",
        &r!("buildWebPage.0.tmpl",
            "ctx.projectName" => ctx.project_name.clone(),
            "buildFeatureList(ctx)" => build_feature_list(&ctx)),
    );
    w!("apps/web/app/globals.css", r!("buildWebCss.0.tmpl"));
    w!("apps/web/lib/api-client.ts", r!("buildWebApiClientHelper.0.tmpl"));
    w!(
        "apps/web/lib/digwis-runtime-modules.ts",
        &build_runtime_modules_helper(&input.runtime_modules),
    );
    scaffold_client_targets(root_path, input, &mut created, web_port);
    w!("packages/ui/README.md", "# Shared UI package\n\nReserve this workspace for cross-project components.\n");
    w!("packages/config/README.md", "# Shared config package\n\nKeep theme and site-level configuration here.\n");

    if input.template == "next-directus" {
        w!("services/directus/README.md", r!("buildDirectusReadme.0.tmpl"));
        w!("services/directus/package.json", build_directus_service_package_json());
        w!("services/directus/.env.example", build_directus_service_env_example(input));
    }

    if input.template == "next-payload" {
        write_payload_cms_template(&input.database, "apps/web", |rel, content| {
            w!(rel, content);
        });
        w!("apps/web/app/(payload)/layout.tsx", r!("buildPayloadLayout.0.tmpl"));
        w!("apps/web/app/(payload)/custom.css", r!("buildPayloadCustomCss.0.tmpl"));
        w!("apps/web/app/(payload)/admin/importMap.ts", r!("buildPayloadImportMap.0.tmpl"));
        w!(
            "apps/web/app/(payload)/admin/[[...segments]]/page.tsx",
            &r!("buildPayloadAdminPage.0.tmpl"),
        );
        w!("apps/web/app/(payload)/api/[...slug]/route.ts", r!("buildPayloadApiRoute.0.tmpl"));
    }

    if ctx.service_modules.contains("python-ai") {
        w!("services/py-ai/requirements.txt", "fastapi>=0.116.0\nuvicorn[standard]>=0.35.0\npydantic>=2.11.0\n");
        w!(
            "services/py-ai/app/main.py",
            &r!("buildPythonMain.0.tmpl", "title" => "Digwis AI worker".to_string(), "kind" => "python-ai".to_string()),
        );
    }
    if ctx.service_modules.contains("python-data") {
        w!("services/py-data/requirements.txt", "fastapi>=0.116.0\nuvicorn[standard]>=0.35.0\npydantic>=2.11.0\n");
        w!(
            "services/py-data/app/main.py",
            &r!("buildPythonMain.0.tmpl", "title" => "Digwis data worker".to_string(), "kind" => "python-data".to_string()),
        );
    }
    if ctx.service_modules.contains("go-worker") {
        w!("services/go-worker/go.mod", format!("module {}/go-worker\n\ngo 1.23\n", ctx.slug));
        w!("services/go-worker/main.go", r!("buildGoMain.0.tmpl", "slug" => ctx.slug.clone()));
    }
    if ctx.service_modules.contains("rust-worker") {
        w!(
            "services/rust-worker/Cargo.toml",
            "[package]\nname = \"rust-worker\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\n",
        );
        w!("services/rust-worker/src/main.rs", r!("buildRustMain.0.tmpl"));
    }

    let contract = build_contract(input, web_port);
    w!(
        "digwis-project.json",
        &(serde_json::to_string_pretty(&contract).unwrap_or_default() + "\n"),
    );
    let light: Vec<String> = input
        .runtime_modules
        .iter()
        .filter(|m| LIGHT_RUNTIME_MODULES.contains(&m.as_str()))
        .cloned()
        .collect();
    for module_id in light {
        let mut warnings = Vec::new();
        ensure_runtime_module_scaffold(
            &module_id,
            root_path,
            &root_path.join("apps").join("web"),
            &input.runtime_modules,
            &mut created,
            &mut warnings,
        );
    }
    (contract, created)
}

fn build_tsconfig() -> String {
    json_string(&serde_json::json!({
        "compilerOptions": {
            "target": "ES2022",
            "lib": ["dom", "dom.iterable", "esnext"],
            "allowJs": true,
            "skipLibCheck": true,
            "strict": true,
            "noEmit": true,
            "esModuleInterop": true,
            "module": "esnext",
            "moduleResolution": "bundler",
            "resolveJsonModule": true,
            "isolatedModules": true,
            "jsx": "preserve",
            "incremental": true,
            "plugins": [{ "name": "next" }],
            "paths": { "@/*": ["./*"] }
        },
        "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        "exclude": ["node_modules"]
    }))
}

// ---------- orchestration ----------

fn ensure_scaffold_root(local_path: &str) -> AppResult<PathBuf> {
    let resolved = PathBuf::from(local_path.trim());
    let resolved = if resolved.is_absolute() {
        resolved
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(resolved)
    };
    if resolved.exists() {
        if !resolved.is_dir() {
            return Err(internal_error("项目路径已存在且不是目录"));
        }
        let mut entries = fs::read_dir(&resolved).map_err(|e| internal_error(e.to_string()))?;
        if entries.next().is_some() {
            return Err(internal_error("项目路径已存在内容，请选择一个空目录或新目录"));
        }
    } else {
        fs::create_dir_all(&resolved).map_err(|e| internal_error(e.to_string()))?;
    }
    fs::canonicalize(&resolved).map_err(|e| internal_error(e.to_string()))
}

fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn read_assigned_web_port(project_path: &str) -> Option<u16> {
    if let Some(runtime) = read_project_local_runtime(project_path) {
        if let Some(url) = runtime.preview_url.as_deref() {
            if let Ok(u) = url::Url::parse(url) {
                if let Some(p) = u.port() {
                    return Some(p);
                }
            }
        }
    }
    let contract_path = Path::new(project_path).join("digwis-project.json");
    if !contract_path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&contract_path).ok()?;
    let parsed: DigwisProjectConfig = serde_json::from_str(&raw).ok()?;
    if let Some(p) = parsed.apps.web.port {
        return Some(p);
    }
    url::Url::parse(&parsed.panel.preview_url).ok()?.port()
}

fn allocate_web_port() -> AppResult<u16> {
    let mut reserved = HashSet::new();
    if let Ok(projects) = crate::db::list_local_projects() {
        for p in projects {
            if let Some(port) = read_assigned_web_port(&p.local_path) {
                reserved.insert(port);
            }
        }
    }
    for port in DEFAULT_WEB_PORT..=MAX_WEB_PORT {
        if reserved.contains(&port) {
            continue;
        }
        if is_port_available(port) {
            return Ok(port);
        }
    }
    Err(internal_error(format!(
        "没有找到可用的本地 Web 端口（已尝试 {DEFAULT_WEB_PORT}-{MAX_WEB_PORT}）"
    )))
}

fn run_command(
    project_root: &str,
    command: &str,
    timeout_ms: u64,
    on_output: Option<Arc<dyn Fn(&str, &str) + Send + Sync>>,
) -> (bool, String) {
    let env = env_with_extra_path();
    let spawn_result = if cfg!(windows) {
        Command::new("cmd.exe")
            .args(["/c", command])
            .current_dir(project_root)
            .envs(&env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        Command::new("/bin/bash")
            .args([
                "-lc",
                &format!("cd \"{}\" && {command}", project_root.replace('"', "\\\"")),
            ])
            .envs(&env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    };
    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => return (false, e.to_string()),
    };
    let combined = Arc::new(std::sync::Mutex::new(String::new()));
    let mut handles = Vec::new();
    for (pipe, stream) in [
        (child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), "stdout"),
        (child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), "stderr"),
    ] {
        if let Some(mut p) = pipe {
            let combined = Arc::clone(&combined);
            let on_output = on_output.clone();
            let stream = stream.to_string();
            handles.push(std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = [0u8; 8192];
                let mut pending = String::new();
                while let Ok(n) = p.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    {
                        let mut c = combined.lock().unwrap();
                        c.push_str(&text);
                        if c.len() > 24_000 {
                            *c = c[c.len() - 18_000..].to_string();
                        }
                    }
                    pending.push_str(&text);
                    pending = pending.replace('\r', "");
                    while let Some(idx) = pending.find('\n') {
                        let line = pending[..idx].trim().to_string();
                        pending = pending[idx + 1..].to_string();
                        if !line.is_empty() {
                            if let Some(ref cb) = on_output {
                                cb(&line, &stream);
                            }
                        }
                    }
                }
                let tail = pending.trim().to_string();
                if !tail.is_empty() {
                    if let Some(ref cb) = on_output {
                        cb(&tail, &stream);
                    }
                }
            }));
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(120));
            }
            Err(_) => break None,
        }
    };
    for h in handles {
        let _ = h.join();
    }
    let out = combined.lock().unwrap().trim().to_string();
    match status {
        None => (false, "command timeout".to_string()),
        Some(s) => (s.success(), out),
    }
}

fn wait_for_http(url_str: &str, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_millis(2500)))
            .build()
            .new_agent();
        match agent.get(url_str).call() {
            Ok(_) => return true,
            Err(ureq::Error::StatusCode(_)) => return true,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(1200)),
        }
    }
    false
}

fn resolve_payload_published_version(project_root: &str) -> String {
    let (ok, out) = run_command(project_root, "npm view payload version", 60_000, None);
    if ok {
        if let Some(v) = out.split_whitespace().last() {
            let v = v.trim();
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    DEFAULT_PAYLOAD_PUBLISHED_VERSION.to_string()
}

fn pull_payload_full_template(target_path: &str, payload_version: &str) -> (bool, String) {
    let command = format!(
        "set -e && tmp_tar=$(mktemp /tmp/payload-website-XXXXXX.tar.gz) && \
         curl -fsSL \"https://codeload.github.com/payloadcms/payload/tar.gz/refs/tags/v{payload_version}\" -o \"$tmp_tar\" && \
         tar -xzf \"$tmp_tar\" -C \"{}\" --strip-components=3 payload-{payload_version}/templates/website && \
         rm -f \"$tmp_tar\"",
        target_path.replace('"', "\\\"")
    );
    run_command(target_path, &command, 10 * 60 * 1000, None)
}

fn patch_payload_folder_api_compatibility(project_root: &Path) {
    let media_path = project_root.join("src").join("collections").join("Media.ts");
    if media_path.exists() {
        if let Ok(mut media) = fs::read_to_string(&media_path) {
            if media.contains("createFolderField") {
                media = media.replace("import { createFolderField } from 'payload'\n", "");
                media = media.replace("\n    createFolderField({ relationTo: 'folders' }),", "");
                if !media.contains("folders: true,") {
                    media = media.replace(
                        "export const Media: CollectionConfig = {\n  slug: 'media',",
                        "export const Media: CollectionConfig = {\n  slug: 'media',\n  folders: true,",
                    );
                }
                let _ = fs::write(&media_path, media);
            }
        }
    }
    let config_path = project_root.join("src").join("payload.config.ts");
    if config_path.exists() {
        if let Ok(config) = fs::read_to_string(&config_path) {
            if config.contains("slug: 'folders'") {
                let re = regex::Regex::new(r"  collections: \[\n    \{\n      slug: 'folders',[\s\S]*?\n    \},\n    Pages,")
                    .unwrap();
                let patched = re.replace(&config, "  collections: [Pages,").to_string();
                let _ = fs::write(&config_path, patched);
            }
        }
    }
}

fn ensure_payload_tsconfig_base_url(project_root: &Path) {
    let tsconfig_path = project_root.join("tsconfig.json");
    if !tsconfig_path.exists() {
        return;
    }
    if let Ok(raw) = fs::read_to_string(&tsconfig_path) {
        if let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            let base = parsed
                .pointer("/compilerOptions/baseUrl")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if base.as_deref() == Some(".") {
                return;
            }
            if let Some(co) = parsed.get_mut("compilerOptions").and_then(|v| v.as_object_mut()) {
                co.insert("baseUrl".into(), ".".into());
            } else {
                parsed["compilerOptions"] = serde_json::json!({"baseUrl": "."});
            }
            let _ = fs::write(&tsconfig_path, serde_json::to_string_pretty(&parsed).unwrap_or_default() + "\n");
        }
    }
}

fn ensure_next_config_allows_loopback(project_root: &Path) {
    for filename in ["next.config.ts", "next.config.js", "next.config.mjs"] {
        let config_path = project_root.join(filename);
        if !config_path.exists() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&config_path) else { continue };
        if raw.contains("allowedDevOrigins") {
            return;
        }
        let re = regex::Regex::new(r"const\s+nextConfig\s*:\s*NextConfig\s*=\s*\{").unwrap();
        if let Some(m) = re.find(&raw) {
            let patched = raw.replacen(
                m.as_str(),
                &format!("{}\n  allowedDevOrigins: [\"127.0.0.1\", \"localhost\"],", m.as_str()),
                1,
            );
            let _ = fs::write(&config_path, patched);
            return;
        }
    }
}

struct PayloadPatchResult {
    version: String,
    database: String,
}

fn patch_full_payload_template(
    project_root: &Path,
    input: &ProjectScaffoldInput,
    web_port: u16,
) -> AppResult<PayloadPatchResult> {
    let package_json_path = project_root.join("package.json");
    if !package_json_path.exists() {
        return Err(internal_error("Payload 模板缺少 package.json"));
    }
    let raw = fs::read_to_string(&package_json_path).map_err(|e| internal_error(e.to_string()))?;
    let mut pkg: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| internal_error(e.to_string()))?;

    let payload_version = resolve_payload_published_version(&project_root.to_string_lossy());
    let mut replaced_packages = Vec::new();
    for section in ["dependencies", "devDependencies"] {
        if let Some(map) = pkg.get_mut(section).and_then(|v| v.as_object_mut()) {
            for (name, version) in map.iter_mut() {
                if version.as_str() == Some("workspace:*") {
                    *version = serde_json::Value::String(payload_version.clone());
                    replaced_packages.push(name.clone());
                }
            }
        }
    }
    {
        let deps = pkg
            .get_mut("dependencies")
            .and_then(|v| v.as_object_mut())
            .cloned()
            .unwrap_or_default();
        let mut deps = deps;
        deps.remove("@payloadcms/db-mongodb");
        if input.database == "postgresql" {
            deps.insert("@payloadcms/db-postgres".into(), payload_version.clone().into());
            if !deps.contains_key("pg") {
                deps.insert("pg".into(), "^8.16.3".into());
            }
        } else {
            deps.insert("@payloadcms/db-sqlite".into(), payload_version.clone().into());
        }
        pkg["dependencies"] = serde_json::Value::Object(deps);
    }
    if let Some(scripts) = pkg.get_mut("scripts").and_then(|v| v.as_object_mut()) {
        if scripts.contains_key("dev") {
            scripts.insert(
                "dev".into(),
                format!("next dev --hostname 127.0.0.1 --port {web_port}").into(),
            );
        }
        if scripts.contains_key("start") {
            scripts.insert(
                "start".into(),
                format!("next start --hostname 127.0.0.1 --port {web_port}").into(),
            );
        }
        if input.client_targets.iter().any(|t| t == "electron") {
            scripts.insert("desktop:dev".into(), "pnpm --filter desktop dev".into());
            scripts.insert("desktop:start".into(), "pnpm --filter desktop start".into());
            scripts.insert("desktop:build".into(), "pnpm --filter desktop build".into());
        }
    }
    {
        let mut workspaces: Vec<serde_json::Value> = pkg
            .get("workspaces")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        for p in build_workspace_patterns() {
            let v = serde_json::Value::String(p.to_string());
            if !workspaces.contains(&v) {
                workspaces.push(v);
            }
        }
        pkg["workspaces"] = serde_json::Value::Array(workspaces);
        if pkg.get("packageManager").is_none() {
            pkg["packageManager"] = "pnpm@10".into();
        }
    }
    fs::write(&package_json_path, serde_json::to_string_pretty(&pkg).unwrap_or_default() + "\n")
        .map_err(|e| internal_error(e.to_string()))?;

    write_payload_cms_template(&input.database, "src", |rel, content| {
        if rel.ends_with("collections/Users.ts")
            || rel.ends_with("collections/Media.ts")
            || rel.ends_with("collections/Categories.ts")
            || rel.ends_with("collections/Pages.ts")
            || rel.ends_with("collections/Posts.ts")
        {
            return;
        }
        let absolute = project_root.join(rel);
        if !absolute.exists() {
            if let Some(dir) = absolute.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::write(&absolute, content);
        }
    });

    let config_path = project_root.join("src").join("payload.config.ts");
    if config_path.exists() {
        if let Ok(mut config) = fs::read_to_string(&config_path) {
            let import_re = regex::Regex::new(
                r#"import\s+\{\s*mongooseAdapter\s*\}\s+from\s+['"]@payloadcms/db-mongodb['"]"#,
            )
            .unwrap();
            let new_import = if input.database == "postgresql" {
                "import { postgresAdapter } from '@payloadcms/db-postgres'"
            } else {
                "import { sqliteAdapter } from '@payloadcms/db-sqlite'"
            };
            config = import_re.replace(&config, new_import).to_string();
            let db_re = regex::Regex::new(
                r"db:\s*mongooseAdapter\(\{\s*url:\s*process\.env\.DATABASE_URL,\s*\}\),",
            )
            .unwrap();
            let new_db = if input.database == "postgresql" {
                "db: postgresAdapter({\n    pool: {\n      connectionString: process.env.DATABASE_URL || \"\",\n    },\n  }),"
            } else {
                "db: sqliteAdapter({\n    client: {\n      url: process.env.DATABASE_URL || \"file:./local.db\",\n    },\n  }),"
            };
            config = db_re.replace(&config, new_db).to_string();
            config = config.replace(
                "import sharp from 'sharp'\n",
                "let sharp: typeof import('sharp').default | undefined\ntry {\n  sharp = (await import('sharp')).default\n} catch {\n  sharp = undefined\n}\n",
            );
            let _ = fs::write(&config_path, config);
        }
    }
    ensure_next_config_allows_loopback(project_root);
    ensure_payload_tsconfig_base_url(project_root);
    patch_payload_folder_api_compatibility(project_root);

    let secret = random_hex(24);
    let env_content = build_full_payload_env(input, &secret, web_port);
    let _ = fs::write(project_root.join(".env"), &env_content);
    let _ = fs::write(
        project_root.join(".env.example"),
        build_full_payload_env(input, "change-me-before-production", web_port),
    );

    Ok(PayloadPatchResult {
        version: payload_version,
        database: input.database.clone(),
    })
}

fn build_npm_fallback_install_command(contract: &DigwisProjectConfig) -> String {
    let web_path = contract.apps.web.path.trim();
    let web_path = if web_path.is_empty() { "apps/web" } else { web_path };
    if web_path == "." || web_path == "./" {
        return "npm install".to_string();
    }
    r!("buildNpmFallbackInstallCommand.0.tmpl",
        "JSON.stringify(webPath)" => serde_json::to_string(web_path).unwrap_or_default())
}

fn start_dev_server_detached_at_root(project_root: &str) -> DetachedStart {
    let runtime_dir = Path::new(project_root).join(".digwis-panel");
    let _ = fs::create_dir_all(&runtime_dir);
    let log_path = runtime_dir.join("local-dev.log");
    let dev_command = "npm run dev";
    match spawn_detached(project_root, dev_command, Some(&log_path)) {
        Ok(pid) => DetachedStart {
            pid: Some(pid),
            log_path: log_path.to_string_lossy().to_string(),
        },
        Err(_) => DetachedStart {
            pid: None,
            log_path: log_path.to_string_lossy().to_string(),
        },
    }
}

fn log_scaffold(project_id: Option<&str>, chunk: &str, stream: &str) {
    if let Some(id) = project_id {
        let _ = append_operation_log(id, stream, chunk, None);
    }
}

struct Progress {
    cb: Arc<dyn Fn(&ProjectScaffoldProgressEvent) + Send + Sync>,
    display_name: String,
    local_path: String,
}

impl Progress {
    fn report(&self, stage: &str, status: &str, percent: u32, message: &str, detail: Option<String>, project_id: Option<String>) {
        (self.cb)(&ProjectScaffoldProgressEvent {
            stage: stage.to_string(),
            status: status.to_string(),
            percent,
            message: message.to_string(),
            detail,
            local_path: self.local_path.clone(),
            display_name: self.display_name.clone(),
            project_id,
            at: now_iso(),
        });
    }
}

pub fn create_project_scaffold(
    payload: &ProjectScaffoldInput,
    on_progress: Option<Arc<dyn Fn(&ProjectScaffoldProgressEvent) + Send + Sync>>,
) -> AppResult<ProjectScaffoldResult> {
    let resolved_root = ensure_scaffold_root(&payload.local_path)?;
    let resolved_root_str = resolved_root.to_string_lossy().to_string();
    let web_port = allocate_web_port()?;
    let mut warnings: Vec<String> = Vec::new();
    let use_full_payload = payload.template == "next-payload" && payload.full_template_pull.unwrap_or(false);
    let use_full_directus = payload.template == "next-directus" && payload.full_template_pull.unwrap_or(false);
    let cb = on_progress.unwrap_or_else(|| Arc::new(|_e: &ProjectScaffoldProgressEvent| {}));
    let report = Progress {
        cb,
        display_name: payload.display_name.clone(),
        local_path: resolved_root_str.clone(),
    };

    report.report("prepare", "running", 4, "正在准备项目目录", Some(format!("已分配本地预览端口 {web_port}")), None);

    let contract: DigwisProjectConfig;
    let created_files: Vec<String>;
    if use_full_payload {
        report.report("template", "running", 18, "正在载入 Payload 完整模板",
            Some("正在在线拉取 Payload 官方 website 模板。".into()), None);
        let payload_version = resolve_payload_published_version(&resolved_root_str);
        let (ok, output) = pull_payload_full_template(&resolved_root_str, &payload_version);
        if !ok {
            report.report("failed", "error", 100, "拉取 Payload 完整模板失败",
                Some(if output.is_empty() { "unknown error".into() } else { output.clone() }), None);
            return Err(internal_error(format!(
                "拉取 Payload 官方 website 模板失败：{}",
                if output.is_empty() { "unknown error".to_string() } else { output }
            )));
        }
        let normalized = patch_full_payload_template(&resolved_root, payload, web_port)?;
        report.report("template", "running", 28, "正在修正 Payload 模板配置",
            Some(format!("已切换到 {}，workspace 依赖改为 {}，并自动生成 website 模板运行环境", normalized.database, normalized.version)), None);
        contract = build_contract_for_full_payload(payload, web_port);
        fs::write(
            resolved_root.join("digwis-project.json"),
            serde_json::to_string_pretty(&contract).unwrap_or_default() + "\n",
        )
        .map_err(|e| internal_error(e.to_string()))?;
        let mut files = vec![
            "digwis-project.json".to_string(),
            "package.json".to_string(),
            "src/payload.config.ts".to_string(),
            "src/collections/Pages.ts".to_string(),
            "src/collections/Posts.ts".to_string(),
            "src/collections/Categories.ts".to_string(),
            "src/collections/Tags.ts".to_string(),
            "src/globals/SiteSettings.ts".to_string(),
            "src/globals/MainNavigation.ts".to_string(),
            "src/app/(payload)/admin/[[...segments]]/page.tsx".to_string(),
        ];
        scaffold_client_targets(&resolved_root, payload, &mut files, web_port);
        created_files = files;
        warnings.push("已在线拉取 Payload 官方 website 模板，并注入 Digwis 运行补丁；项目结构是单体应用，不是 apps/web。".into());
    } else if use_full_directus {
        report.report("template", "running", 18, "正在生成 Next + Directus 完整项目模板", None, None);
        let (_gen_contract, mut files) = generate_project_scaffold_files(payload, &resolved_root, web_port);
        contract = build_contract_for_full_directus(payload, web_port);
        fs::write(
            resolved_root.join("digwis-project.json"),
            serde_json::to_string_pretty(&contract).unwrap_or_default() + "\n",
        )
        .map_err(|e| internal_error(e.to_string()))?;
        let sidecar = resolved_root.join("services").join("directus");
        for sub in ["", "uploads", "extensions", "snapshots"] {
            let _ = fs::create_dir_all(sidecar.join(sub));
        }
        if payload.database == "sqlite" {
            let _ = fs::create_dir_all(sidecar.join("database"));
        }
        fs::write(sidecar.join("docker-compose.yml"), build_directus_full_docker_compose(payload))
            .map_err(|e| internal_error(e.to_string()))?;
        let env = build_directus_full_env(payload);
        let _ = fs::write(sidecar.join(".env"), &env);
        let _ = fs::write(sidecar.join(".env.example"), &env);
        let _ = fs::write(
            sidecar.join("README.md"),
            "# Directus Full Sidecar\n\nRun `npm run directus:up` from project root and open http://127.0.0.1:8055/admin\n",
        );
        fs::write(resolved_root.join("package.json"), build_directus_full_root_package_json(payload, web_port))
            .map_err(|e| internal_error(e.to_string()))?;
        for extra in [
            "services/directus/docker-compose.yml",
            "services/directus/.env",
            "services/directus/.env.example",
            "services/directus/README.md",
            "digwis-project.json",
            "package.json",
        ] {
            files.push(extra.to_string());
        }
        created_files = files;
        warnings.push("已生成 Directus 完整 sidecar（docker-compose），可直接 `npm run directus:up`。".into());
    } else {
        report.report("template", "running", 18, "正在生成平台项目骨架", None, None);
        let (c, files) = generate_project_scaffold_files(payload, &resolved_root, web_port);
        contract = c;
        created_files = files;
    }

    report.report("template", "success", 34, "模板文件已准备完成",
        Some(format!("{} 个项目文件已写入", created_files.len())), None);

    if payload.service_modules.iter().any(|m| m == "go-worker" || m == "rust-worker") {
        warnings.push("Go/Rust worker 已生成骨架，但依赖安装和运行环境仍需在目标机器上准备。".into());
    }

    let auto_install = payload.auto_install.unwrap_or(true);
    let auto_start = payload.auto_start.unwrap_or(true);
    let mut bootstrap = ProjectScaffoldBootstrap {
        attempted: auto_install || auto_start,
        install_ok: false,
        start_ok: false,
        preview_url: Some(contract.panel.preview_url.clone()),
        health_checks: Vec::new(),
    };

    let created_project = match crate::db::add_local_project_from_path(&LocalProjectInput {
        local_path: resolved_root_str.clone(),
        display_name: Some(payload.display_name.clone()),
        category: Some("local-dev".into()),
    }) {
        Ok(p) => {
            report.report("register", "success", 42, "项目已加入面板", None, Some(p.id.clone()));
            log_scaffold(Some(&p.id), &format!("[scaffold] registered localPath={resolved_root_str}\n"), "system");
            p
        }
        Err(e) => {
            report.report("failed", "error", 100, "项目写入成功，但加入面板失败", Some(e.to_string()), None);
            let _ = fs::remove_dir_all(&resolved_root);
            return Err(e);
        }
    };
    let pid = created_project.id.clone();

    if auto_install {
        let fallback_install_command = build_npm_fallback_install_command(&contract);
        report.report("install", "running", 52, "正在安装项目依赖",
            Some(if use_full_payload || use_full_directus { "pnpm install || npm install".into() } else { "pnpm install".into() }),
            Some(pid.clone()));
        log_scaffold(Some(&pid), "[scaffold] install start\n", "system");
        let install_command = if use_full_payload || use_full_directus {
            "pnpm install || npm install"
        } else {
            "pnpm install"
        };
        let step = Arc::new(std::sync::Mutex::new(0u32));
        let pid2 = pid.clone();
        let publish = {
            let step = Arc::clone(&step);
            let cb = report.cb.clone();
            let display_name = payload.display_name.clone();
            let local_path = resolved_root_str.clone();
            move |line: &str, stream: &str| {
                let mut s = step.lock().unwrap();
                *s += 1;
                let percent = (52 + *s / 3).min(70);
                let detail: String = line.chars().take(220).collect();
                (cb)(&ProjectScaffoldProgressEvent {
                    stage: "install".into(),
                    status: if stream == "stderr" { "warning".into() } else { "running".into() },
                    percent,
                    message: "正在安装项目依赖".into(),
                    detail: Some(detail),
                    local_path: local_path.clone(),
                    display_name: display_name.clone(),
                    project_id: Some(pid2.clone()),
                    at: now_iso(),
                });
            }
        };
        let (mut install_ok, install_out) = run_command(&resolved_root_str, install_command, 30 * 60 * 1000, Some(Arc::new(publish)));
        let mut install_detail = install_out;
        if !install_ok {
            report.report("install", "warning", 66, "pnpm 安装失败，正在回退到 npm",
                Some(fallback_install_command.clone()), Some(pid.clone()));
            let pid3 = pid.clone();
            let step2 = Arc::clone(&step);
            let cb2 = report.cb.clone();
            let display_name2 = payload.display_name.clone();
            let local_path2 = resolved_root_str.clone();
            let publish2 = move |line: &str, stream: &str| {
                let mut s = step2.lock().unwrap();
                *s += 1;
                let percent = (52 + *s / 3).min(70);
                let detail: String = line.chars().take(220).collect();
                (cb2)(&ProjectScaffoldProgressEvent {
                    stage: "install".into(),
                    status: if stream == "stderr" { "warning".into() } else { "running".into() },
                    percent,
                    message: "正在安装项目依赖".into(),
                    detail: Some(detail),
                    local_path: local_path2.clone(),
                    display_name: display_name2.clone(),
                    project_id: Some(pid3.clone()),
                    at: now_iso(),
                });
            };
            let (ok2, out2) = run_command(&resolved_root_str, &fallback_install_command, 30 * 60 * 1000, Some(Arc::new(publish2)));
            install_ok = ok2;
            install_detail = format!("{install_detail}\n--- fallback {fallback_install_command} ---\n{out2}").trim().to_string();
        }
        bootstrap.install_ok = install_ok;
        if install_ok {
            let repaired = repair_project_native_modules(&resolved_root_str);
            if !repaired.is_empty() {
                log_scaffold(Some(&pid), &format!("[scaffold] repaired native modules\n{}\n", repaired.join("\n")), "system");
            }
        }
        bootstrap.health_checks.push(ProjectScaffoldBootstrapHealthCheck {
            name: "install".into(),
            ok: install_ok,
            detail: Some(if install_ok {
                "dependency installation completed".into()
            } else {
                install_detail.chars().rev().take(300).collect::<String>().chars().rev().collect()
            }),
        });
        log_scaffold(
            Some(&pid),
            &if install_ok {
                "[scaffold] install success\n".to_string()
            } else {
                format!("[scaffold] install failed\n{}\n", install_detail.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>())
            },
            if install_ok { "system" } else { "stderr" },
        );
        report.report("install", if install_ok { "success" } else { "warning" },
            if install_ok { 72 } else { 70 },
            if install_ok { "项目依赖安装完成" } else { "项目依赖安装失败，已保留目录" },
            Some(if install_ok {
                "可以继续自动启动预览".into()
            } else {
                install_detail.chars().rev().take(220).collect::<String>().chars().rev().collect()
            }),
            Some(pid.clone()));
        if !install_ok {
            warnings.push(format!("自动安装依赖失败，已保留项目目录，可手动执行 {fallback_install_command}。"));
        }
    } else {
        bootstrap.install_ok = true;
    }

    if auto_start && bootstrap.install_ok {
        report.report("start", "running", 82, "正在启动本地预览服务",
            Some(contract.panel.preview_url.clone()), Some(pid.clone()));
        log_scaffold(Some(&pid), &format!("[scaffold] start preview={}\n", contract.panel.preview_url), "system");
        let started = start_dev_server_detached_at_root(&resolved_root_str);
        let detected = wait_for_preview_url_from_log(&started.log_path, 20_000);
        let effective_preview_url = detected.unwrap_or_else(|| contract.panel.preview_url.clone());
        let effective_admin_url = resolve_admin_url_from_preview(&effective_preview_url, Some(&contract.panel.admin_url));
        let _ = write_project_local_runtime(
            &resolved_root_str,
            Some(effective_preview_url.clone()),
            Some(effective_admin_url.clone()),
            started.pid,
            Some(started.log_path.clone()),
        );
        bootstrap.preview_url = Some(effective_preview_url.clone());
        let ready = wait_for_http(&effective_preview_url, 45_000);
        bootstrap.start_ok = ready;
        bootstrap.health_checks.push(ProjectScaffoldBootstrapHealthCheck {
            name: "preview".into(),
            ok: ready,
            detail: Some(if ready {
                format!("dev server reachable at {effective_preview_url}")
            } else {
                "dev server not reachable in 45s".into()
            }),
        });
        if !ready {
            warnings.push("已尝试后台启动开发服务，但在 45 秒内未探测到可访问页面。".into());
        } else if let Some(p) = started.pid {
            bootstrap.health_checks.push(ProjectScaffoldBootstrapHealthCheck {
                name: "pid".into(),
                ok: true,
                detail: Some(format!("dev server pid {p}")),
            });
        }
        log_scaffold(
            Some(&pid),
            &if ready {
                format!("[scaffold] preview ready {effective_preview_url}{}\n", started.pid.map(|p| format!(" pid={p}")).unwrap_or_default())
            } else {
                format!("[scaffold] preview not reachable {effective_preview_url}\n")
            },
            if ready { "system" } else { "stderr" },
        );
        report.report("start", if ready { "success" } else { "warning" },
            if ready { 90 } else { 88 },
            if ready { "本地预览已可访问" } else { "本地预览尚未就绪" },
            Some(if ready { effective_preview_url.clone() } else { "45 秒内未探测到可访问页面".into() }),
            Some(pid.clone()));

        if use_full_directus {
            report.report("admin", "running", 92, "正在启动 Directus 管理端",
                Some(contract.panel.admin_url.clone()), Some(pid.clone()));
            let (ok, out) = run_command(&resolved_root_str, "npm run directus:up", 2 * 60 * 1000, None);
            bootstrap.health_checks.push(ProjectScaffoldBootstrapHealthCheck {
                name: "directus-up".into(),
                ok,
                detail: Some(if ok { "directus sidecar started".into() } else {
                    out.chars().rev().take(300).collect::<String>().chars().rev().collect()
                }),
            });
            log_scaffold(
                Some(&pid),
                &if ok {
                    "[scaffold] directus sidecar started\n".to_string()
                } else {
                    format!("[scaffold] directus sidecar failed\n{}\n", out.chars().rev().take(500).collect::<String>().chars().rev().collect::<String>())
                },
                if ok { "system" } else { "stderr" },
            );
            if ok {
                let admin_ready = wait_for_http(&effective_admin_url, 45_000);
                bootstrap.health_checks.push(ProjectScaffoldBootstrapHealthCheck {
                    name: "directus-admin".into(),
                    ok: admin_ready,
                    detail: Some(if admin_ready {
                        format!("directus admin reachable at {effective_admin_url}")
                    } else {
                        "directus admin not reachable in 45s".into()
                    }),
                });
                log_scaffold(
                    Some(&pid),
                    &format!("[scaffold] directus admin {} {effective_admin_url}\n", if admin_ready { "ready" } else { "not reachable" }),
                    if admin_ready { "system" } else { "stderr" },
                );
                report.report("admin", if admin_ready { "success" } else { "warning" },
                    if admin_ready { 97 } else { 95 },
                    if admin_ready { "Directus 管理端已可访问" } else { "Directus 管理端尚未就绪" },
                    Some(if admin_ready { effective_admin_url.clone() } else { "45 秒内未探测到管理端可访问".into() }),
                    Some(pid.clone()));
                if !admin_ready {
                    warnings.push("Directus sidecar 已启动，但 /admin 在 45 秒内未就绪。".into());
                }
            } else {
                report.report("admin", "warning", 95, "Directus sidecar 自动启动失败",
                    Some(out.chars().rev().take(220).collect::<String>().chars().rev().collect()),
                    Some(pid.clone()));
                warnings.push("Directus sidecar 自动启动失败，可手动执行 npm run directus:up。".into());
            }
        }
    } else if auto_start {
        bootstrap.health_checks.push(ProjectScaffoldBootstrapHealthCheck {
            name: "preview".into(),
            ok: false,
            detail: Some("skip start because install failed".into()),
        });
        report.report("start", "warning", 82, "跳过本地预览启动",
            Some("因为依赖安装失败，未继续自动启动。".into()), Some(pid.clone()));
    }

    report.report("done", if warnings.is_empty() { "success" } else { "warning" }, 100,
        if warnings.is_empty() { "项目已创建完成" } else { "项目已创建，但有后续注意事项" },
        warnings.first().cloned(), Some(pid.clone()));
    log_scaffold(Some(&pid), "[scaffold] done\n", if warnings.is_empty() { "system" } else { "stderr" });

    Ok(ProjectScaffoldResult {
        ok: true,
        message: "已生成项目骨架并加入面板".into(),
        project: created_project,
        local_path: resolved_root_str,
        created_files,
        warnings,
        contract,
        bootstrap: Some(bootstrap),
    })
}
