/**
 * PiLab plugin manifest, schema version 1 (plugin-system README §3).
 *
 * Adapted from PI-Desktop's manifest (docs/spec/07-plugins/02-plugin-manifest-schema.md):
 * the same root fields, with only the two contribution points v1 implements
 * (`settings`, `services`) and `apiVersion` in place of an engine semver range.
 */

import { z } from 'zod';

/** Host API major version this build serves. */
export const PLUGIN_API_VERSION = 1;

/** Manifest file at the package root. */
export const PLUGIN_MANIFEST_FILE = 'manifest.json';

/** Distribution package extension: a zip with `manifest.json` at its root. */
export const PLUGIN_PACKAGE_EXTENSION = '.pilabplug';

export const PLUGIN_PERMISSIONS = ['chat.read', 'chat.control'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const MAX_PLUGIN_SERVICES = 4;

const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const LOCAL_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** A path inside the package: relative, forward slashes, no `..` segment. */
const packagePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[a-zA-Z]:/.test(value) &&
      !value.split('/').includes('..'),
    'must be a relative path inside the package'
  );

const settingContrib = z
  .object({
    key: z.string().regex(LOCAL_ID_PATTERN),
    title: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(['string', 'number', 'boolean', 'select']),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z
      .array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) }))
      .optional(),
    /** Stored encrypted and never shown back in full. */
    secret: z.boolean().optional(),
  })
  .refine((setting) => setting.type !== 'select' || (setting.options?.length ?? 0) > 0, {
    message: 'a select setting needs options',
  });

const serviceContrib = z.object({
  id: z.string().regex(LOCAL_ID_PATTERN),
  title: z.string().optional(),
  /** Restart the plugin when it dies while the service runs. Default true. */
  autoRestart: z.boolean().optional(),
});

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(ID_PATTERN),
  name: z.string().min(1),
  version: z.string().regex(SEMVER_PATTERN),
  description: z.string().optional(),
  author: z.string().optional(),
  apiVersion: z.number().int().positive(),
  main: packagePath,
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).default([]),
  /** Hosts the plugin connects to, shown at install; not enforced in v1. */
  net: z.object({ hosts: z.array(z.string().min(1)).default([]) }).optional(),
  contributes: z
    .object({
      settings: z.array(settingContrib).default([]),
      services: z.array(serviceContrib).max(MAX_PLUGIN_SERVICES).default([]),
    })
    .default({ settings: [], services: [] }),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginSettingContrib = PluginManifest['contributes']['settings'][number];
export type PluginServiceContrib = PluginManifest['contributes']['services'][number];

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

/** Validate a parsed `manifest.json`, including what zod alone cannot see. */
export function parsePluginManifest(raw: unknown): ManifestResult {
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `invalid manifest at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown'}`,
    };
  }
  const manifest = parsed.data;
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `plugin needs host API ${manifest.apiVersion}, this PiLab serves ${PLUGIN_API_VERSION}`,
    };
  }
  for (const [label, ids] of [
    ['setting key', manifest.contributes.settings.map((s) => s.key)],
    ['service id', manifest.contributes.services.map((s) => s.id)],
  ] as const) {
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) return { ok: false, error: `duplicate ${label}: ${duplicate}` };
  }
  return { ok: true, manifest };
}
