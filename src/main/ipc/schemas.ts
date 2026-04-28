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

export const vpsConnectionInputSchema = z
  .object({
    id: optionalNonEmptyString(),
    name: nonEmptyString("name"),
    host: nonEmptyString("host"),
    port: z.number().int().min(1).max(65535),
    username: nonEmptyString("username"),
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
