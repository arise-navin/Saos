import crypto from 'node:crypto';
import { table, SnowError } from './client.js';

/**
 * Update set XML export, built from Table API reads.
 *
 * No undocumented endpoint is involved, and that is not only a preference —
 * it was measured. `export_update_set.do` is the platform's own exporter and it
 * answers **401 to basic auth**: it wants a UI session, which a headless tool
 * does not have. The record serializer (`sys_update_xml_list.do?XML`) DOES
 * authenticate, but it emits the generic `<xml>` list format rather than the
 * `<unload>` an import expects, so it is a useful reference and not a
 * substitute. What ships builds the file itself.
 *
 * The format was read off that reference rather than recalled, and one detail
 * in it is load-bearing:
 *
 *   The platform puts a payload in CDATA — UNLESS the payload itself contains
 *   a CDATA section, in which case it entity-escapes instead. Measured on two
 *   rows of the same set: a catalog item came back wrapped, and a business rule
 *   came back escaped, because its payload carries
 *   `<script><![CDATA[…]]></script>` and CDATA cannot nest.
 *
 * An exporter that always wrapped would therefore emit INVALID XML for every
 * script-bearing artifact — business rules, script includes, UI actions — and
 * the file would truncate at the first `]]>` or fail to parse. This one always
 * escapes, which is unconditionally valid, round-trips to the identical string,
 * and removes the conditional entirely.
 *
 * Exports are DETERMINISTIC: the same set exported twice is byte-identical
 * apart from `unload_date`, because the remote set's sys_id is derived from the
 * local one rather than randomly generated. That is what lets the offline suite
 * assert the format without an instance.
 */

const raw = (cell) => (cell && typeof cell === 'object' ? cell.value : cell);

/** Escape text for an XML text node. Always valid; never conditional. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `<name>value</name>`, or `<name/>` when empty — the platform's own convention. */
function el(name, value) {
  const v = value === null || value === undefined ? '' : String(value);
  return v === '' ? `<${name}/>` : `<${name}>${esc(v)}</${name}>`;
}

/**
 * A stable sys_id for the exported remote set, derived from the local one.
 *
 * A random GUID would make two exports of an unchanged set differ, which makes
 * "did this export change?" unanswerable and the parity test untestable
 * offline. A hash is stable, and 32 hex is the shape the platform expects.
 */
export function derivedRemoteSysId(localSysId) {
  return crypto.createHash('sha256').update(`nha-remote:${localSysId}`).digest('hex').slice(0, 32);
}

/** Fields carried on each exported row, in the platform's alphabetical order. */
const ROW_FIELDS = [
  'action', 'application', 'category', 'comments', 'name', 'payload', 'payload_hash',
  'replace_on_upgrade', 'sys_created_by', 'sys_created_on', 'sys_id', 'sys_mod_count',
  'sys_recorded_at', 'sys_updated_by', 'sys_updated_on', 'table', 'target_name', 'type',
  'update_domain', 'update_guid', 'update_guid_history', 'view',
];

/**
 * Build the XML for one local update set.
 *
 * Returns the text AND the manifest it was built from, so the caller can verify
 * parity without re-reading the instance.
 */
export async function buildUpdateSetXml(setSysId, { unloadDate = null } = {}) {
  const sets = await table.query('sys_update_set', {
    query: `sys_id=${setSysId}`,
    fields: 'sys_id,name,description,state,application,parent,release_date,origin_sys_id,sys_created_by,sys_created_on',
    limit: 1, display: 'false',
  });
  if (!sets.length) throw new SnowError(`Update set ${setSysId} does not exist on this instance.`, 404);
  const set = sets[0];

  const rows = await table.query('sys_update_xml', {
    query: `update_set=${setSysId}^ORDERBYsys_recorded_at`,
    fields: [...ROW_FIELDS, 'update_set'].join(','),
    limit: 5000, display: 'false',
  });

  // The scope's name and version travel in the header. A scoped set that
  // arrives without them imports against the wrong application.
  const appId = raw(set.application) || 'global';
  let applicationName = 'Global';
  let applicationScope = 'global';
  let applicationVersion = '';
  if (appId !== 'global') {
    const scope = await table.query('sys_scope', { query: `sys_id=${appId}`, fields: 'name,scope,version', limit: 1, display: 'false' });
    applicationName = raw(scope[0]?.name) || appId;
    applicationScope = raw(scope[0]?.scope) || appId;
    applicationVersion = raw(scope[0]?.version) || '';
  }

  const remoteSysId = derivedRemoteSysId(raw(set.sys_id));
  const inserted = rows.filter((r) => raw(r.action) !== 'DELETE').length;
  const deleted = rows.filter((r) => raw(r.action) === 'DELETE').length;

  const header = [
    '<sys_remote_update_set action="INSERT_OR_UPDATE">',
    el('application', appId),
    el('application_name', applicationName),
    el('application_scope', applicationScope),
    el('application_version', applicationVersion),
    el('collisions', ''),
    el('commit_date', ''),
    el('deleted', String(deleted)),
    el('description', raw(set.description)),
    el('inserted', String(inserted)),
    el('name', raw(set.name)),
    el('origin_sys_id', raw(set.origin_sys_id)),
    el('parent', ''),
    el('release_date', raw(set.release_date)),
    el('remote_base_update_set', ''),
    el('remote_parent_id', ''),
    // How the target instance correlates this back to where it came from.
    el('remote_sys_id', raw(set.sys_id)),
    el('state', 'loaded'),
    el('summary', String(rows.length)),
    el('sys_class_name', 'sys_remote_update_set'),
    el('sys_created_by', raw(set.sys_created_by)),
    el('sys_created_on', raw(set.sys_created_on)),
    el('sys_id', remoteSysId),
    el('sys_mod_count', '0'),
    el('sys_updated_by', raw(set.sys_created_by)),
    el('sys_updated_on', raw(set.sys_created_on)),
    el('update_set', ''),
    el('update_source', ''),
    el('updated', '0'),
    '</sys_remote_update_set>',
  ].join('\n');

  const body = rows.map((r) => [
    '<sys_update_xml action="INSERT_OR_UPDATE">',
    ...ROW_FIELDS.map((f) => el(f, raw(r[f]))),
    // On the target instance these rows belong to the RETRIEVED set, not to a
    // local one — so remote_update_set points at the header and update_set is
    // empty. Getting this backwards produces a file that imports into nothing.
    el('remote_update_set', remoteSysId),
    el('update_set', ''),
    '</sys_update_xml>',
  ].join('\n')).join('\n');

  const stamp = unloadDate || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<unload unload_date="${esc(stamp)}">`,
    header,
    body,
    '</unload>',
    '',
  ].join('\n');

  return {
    xml,
    filename: `${String(raw(set.name) || 'update-set').replace(/[^\w.-]+/g, '_')}.xml`,
    manifest: {
      setSysId: raw(set.sys_id),
      setName: raw(set.name),
      remoteSysId,
      application: appId,
      applicationScope,
      count: rows.length,
      inserted,
      deleted,
      rows: rows.map((r) => ({ name: raw(r.name), payloadHash: raw(r.payload_hash), target: raw(r.target_name), type: raw(r.type) })),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Parity — re-parse what we wrote and compare it to what we read
 * ------------------------------------------------------------------ */

/**
 * A deliberately small XML reader for exactly the shape we emit.
 *
 * A general parser is not needed and would hide the point: this exists to prove
 * the export can be read back, so it reads the file the way an importer would —
 * from the text, with no access to the objects that produced it.
 */
export function parseUpdateSetXml(xml) {
  const unesc = (s) => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  const field = (block, name) => {
    if (new RegExp(`<${name}/>`).test(block)) return '';
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
    return m ? unesc(m[1]) : null;
  };

  const headerBlock = /<sys_remote_update_set[^>]*>([\s\S]*?)<\/sys_remote_update_set>/.exec(xml);
  const rowBlocks = [...xml.matchAll(/<sys_update_xml[^>]*>([\s\S]*?)<\/sys_update_xml>/g)];

  return {
    unloadDate: /<unload unload_date="([^"]*)"/.exec(xml)?.[1] ?? null,
    header: headerBlock ? {
      name: field(headerBlock[1], 'name'),
      remoteSysId: field(headerBlock[1], 'remote_sys_id'),
      sysId: field(headerBlock[1], 'sys_id'),
      application: field(headerBlock[1], 'application'),
      applicationScope: field(headerBlock[1], 'application_scope'),
      summary: field(headerBlock[1], 'summary'),
    } : null,
    updates: rowBlocks.map(([, b]) => ({
      name: field(b, 'name'),
      payload: field(b, 'payload'),
      payloadHash: field(b, 'payload_hash'),
      target: field(b, 'target_name'),
      type: field(b, 'type'),
      action: field(b, 'action'),
      remoteUpdateSet: field(b, 'remote_update_set'),
    })),
  };
}

/**
 * Does the exported XML say the same thing as the rows it was built from?
 *
 * Count, names and payload hashes — and the payload hash is the one that
 * matters, because a name list can match perfectly while the content is
 * truncated. Every difference is named; `ok` is only true when there are none.
 */
export function verifyExportParity(xml, manifest) {
  const parsed = parseUpdateSetXml(xml);
  const problems = [];

  if (!parsed.header) problems.push('the export has no sys_remote_update_set header');
  else {
    if (parsed.header.remoteSysId !== manifest.setSysId) {
      problems.push(`header remote_sys_id is ${parsed.header.remoteSysId}, expected the local set ${manifest.setSysId}`);
    }
    if (Number(parsed.header.summary) !== manifest.count) {
      problems.push(`header summary says ${parsed.header.summary}, the set holds ${manifest.count}`);
    }
  }

  if (parsed.updates.length !== manifest.count) {
    problems.push(`re-parsed ${parsed.updates.length} updates, the set holds ${manifest.count}`);
  }

  const byName = new Map(parsed.updates.map((u) => [u.name, u]));
  for (const row of manifest.rows) {
    const got = byName.get(row.name);
    if (!got) { problems.push(`missing from the export: ${row.name} (${row.target})`); continue; }
    if (got.payloadHash !== row.payloadHash) {
      problems.push(`payload hash differs for ${row.name}: export ${got.payloadHash}, source ${row.payloadHash}`);
    }
    if (!got.payload) problems.push(`empty payload for ${row.name} after re-parsing`);
    if (got.remoteUpdateSet !== manifest.remoteSysId) {
      problems.push(`${row.name} is not attached to the exported set`);
    }
  }
  for (const u of parsed.updates) {
    if (!manifest.rows.some((r) => r.name === u.name)) problems.push(`the export contains ${u.name}, which is not in the set`);
  }

  return {
    ok: problems.length === 0,
    checked: { updates: manifest.count, names: manifest.rows.length, payloadHashes: manifest.rows.length },
    reparsed: parsed.updates.length,
    problems,
  };
}

/** Build and verify in one call — the only shape the route needs. */
export async function exportUpdateSet(setSysId) {
  const built = await buildUpdateSetXml(setSysId);
  const parity = verifyExportParity(built.xml, built.manifest);
  return { ...built, parity };
}
