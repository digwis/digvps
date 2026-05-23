import { z } from "zod"

const nonEmptyString = (label: string) => z.string().trim().min(1, `${label}不能为空`)

const optionalNonEmptyString = () =>
  z
    .string()
    .trim()
    .min(1)
    .optional()

export const connectionIdSchema = nonEmptyString("connectionId")
export const projectIdSchema = nonEmptyString("projectId")

export const localProjectInputSchema = z.object({
  localPath: nonEmptyString("localPath"),
  displayName: optionalNonEmptyString(),
  category: z.literal("local-dev").optional(),
})

export const projectLocalPathUpdateSchema = z.object({
  projectId: projectIdSchema,
  localPath: nonEmptyString("localPath"),
})

export const projectDeleteSchema = z.object({
  projectId: projectIdSchema,
  removeLocalDirectory: z.boolean().optional(),
})

export const projectScaffoldSchema = z.object({
  displayName: nonEmptyString("displayName"),
  slug: z
    .string()
    .trim()
    .min(1, "slug不能为空")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug 只能包含小写字母、数字和连字符"),
  localPath: nonEmptyString("localPath"),
  packageManager: z.literal("pnpm"),
  monorepo: z.boolean(),
  template: z.enum(["next-core", "next-payload", "next-directus"]),
  database: z.enum(["postgresql", "sqlite"]),
  clientTargets: z.array(z.enum(["electron", "ios-native", "android-native"])).max(4),
  runtimeModules: z
    .array(z.enum(["auth", "docs", "dashboard", "blog", "i18n", "search", "queue", "payments", "multi-tenant"]))
    .max(12),
  serviceModules: z
    .array(z.enum(["python-ai", "python-data", "go-worker", "rust-worker"]))
    .max(8),
  autoInstall: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  fullTemplatePull: z.boolean().optional(),
})

export const projectRuntimeModulesUpdateSchema = z.object({
  projectId: projectIdSchema,
  runtimeModules: z
    .array(z.enum(["auth", "docs", "dashboard", "blog", "i18n", "search", "queue", "payments", "multi-tenant"]))
    .max(12),
})

export const projectClientAppSchema = z.object({
  projectId: projectIdSchema,
  target: z.enum(["electron", "ios-native", "android-native"]),
})

export const projectConnectionSchema = z.object({
  projectId: projectIdSchema,
  connectionId: connectionIdSchema,
})

export const projectRemoteDetailsSchema = projectConnectionSchema.extend({
  browsePath: z.string().trim().optional(),
  forceRefresh: z.boolean().optional(),
})

export const projectEnvUpdateSchema = projectConnectionSchema.extend({
  content: z.string(),
})

export const projectSiteSettingsSchema = projectConnectionSchema.extend({
  domain: z.string().trim().optional(),
  sslEmail: z.string().trim().optional(),
  certificatePem: z.string().optional(),
  privateKeyPem: z.string().optional(),
})

export const projectDeploySchema = projectConnectionSchema.extend({
  strategy: z.enum(["sftp", "local-npm-script"]).optional(),
  npmScript: z.string().trim().optional(),
  remoteParentPath: z.string().trim().optional(),
})

export const projectBackupScheduleSchema = z.object({
  projectId: projectIdSchema,
  schedule: z.enum(["off", "daily", "weekly", "monthly"]),
})

export const projectMigrationSchema = z.object({
  projectId: projectIdSchema,
  sourceConnectionId: connectionIdSchema,
  targetConnectionId: connectionIdSchema,
})

export const operationLogsQuerySchema = z
  .object({
    limit: z.number().int().positive().max(5000).optional(),
  })
  .optional()

export const operationLogAppendSchema = z.object({
  projectId: projectIdSchema,
  stream: z.enum(["stdout", "stderr", "system"]),
  chunk: z.string().min(1, "chunk不能为空"),
})

export const vpsConnectionInputSchema = z
  .object({
    id: optionalNonEmptyString(),
    name: nonEmptyString("name"),
    host: nonEmptyString("host"),
    port: z.number().int().min(1).max(65535),
    username: nonEmptyString("username"),
    provider: z.string().trim().max(120).optional(),
    locationLabel: z.string().trim().max(120).optional(),
    expiresAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "到期时间格式必须为 YYYY-MM-DD").optional(),
    authType: z.enum(["password", "privateKey"]),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasStoredId = !!value.id?.trim()
    if (value.authType === "password" && !hasStoredId && !value.password?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "密码认证需要提供 password",
      })
    }
    if (value.authType === "privateKey" && !hasStoredId && !value.privateKey?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["privateKey"],
        message: "私钥认证需要提供 privateKey",
      })
    }
  })

export const sshConfigMutationSchema = z.object({
  configPath: nonEmptyString("configPath"),
  originalName: optionalNonEmptyString(),
  name: nonEmptyString("name"),
  host: nonEmptyString("host"),
  port: z.number().int().min(1).max(65535),
  username: nonEmptyString("username"),
  identityFilePath: z.string().trim().optional(),
})

export const rawSshConfigSaveSchema = z.object({
  content: z.string(),
})

export const sshConfigDeleteSchema = z.object({
  configPath: nonEmptyString("configPath"),
  originalName: nonEmptyString("originalName"),
})

export const remoteBrowseSchema = z.object({
  connectionId: connectionIdSchema,
  path: z.string().trim().optional(),
  forceRefresh: z.boolean().optional(),
})

export const remoteReadSchema = z.object({
  connectionId: connectionIdSchema,
  path: nonEmptyString("path"),
})

const permissionModeSchema = z
  .string()
  .trim()
  .regex(/^[0-7]{3,4}$/, "权限必须是 3 到 4 位八进制数字")

export const remoteWriteSchema = remoteReadSchema.extend({
  content: z.string(),
})

export const remoteCreateDirectorySchema = z.object({
  connectionId: connectionIdSchema,
  parentPath: nonEmptyString("parentPath"),
  directoryName: nonEmptyString("directoryName"),
})

export const remoteRenameSchema = z.object({
  connectionId: connectionIdSchema,
  path: nonEmptyString("path"),
  nextName: nonEmptyString("nextName"),
})

export const remotePermissionSchema = remoteReadSchema.extend({
  mode: permissionModeSchema,
  recursive: z.boolean().optional(),
})

export const remoteUploadSchema = z.object({
  connectionId: connectionIdSchema,
  remotePath: nonEmptyString("remotePath"),
})

export const remoteDownloadSchema = z.object({
  connectionId: connectionIdSchema,
  path: nonEmptyString("path"),
  name: nonEmptyString("name"),
  type: z.enum(["file", "directory", "symlink"]),
})

export const remoteTrashEntrySchema = z.object({
  connectionId: connectionIdSchema,
  trashId: nonEmptyString("trashId"),
})

export const dependencyServiceSchema = z.object({
  dependencyId: nonEmptyString("dependencyId"),
  action: z.enum(["restart", "stop", "start"]),
  systemdUnit: z.string().trim().optional(),
})

export const forceRefreshOptionsSchema = z
  .object({
    forceRefresh: z.boolean().optional(),
  })
  .optional()

export const upgradeApplySchema = z.object({
  reboot: z.boolean(),
})

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  return schema.parse(input)
}
