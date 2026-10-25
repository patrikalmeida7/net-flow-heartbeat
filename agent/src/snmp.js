// Coletor SNMP — biblioteca interna usada por src/index.js
// Suporta SNMPv2c e SNMPv3 (auth+priv).
// Coleta:
//   - sysUpTime, hrSystemUptime
//   - hrProcessorLoad (média) ou MikroTik mtxrHlCoreVoltage/cpu
//   - hrStorageUsed/Size (memória) ou MIKROTIK-MIB
//   - ifTable: ifIndex, ifDescr, ifAlias, ifHighSpeed, ifOperStatus, ifAdminStatus,
//              ifHCInOctets, ifHCOutOctets, ifInErrors, ifOutErrors
import snmp from "net-snmp";

// ---------- OIDs ----------
const OID = {
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  // hrProcessorLoad table (vários cores)
  hrProcessorLoad: "1.3.6.1.2.1.25.3.3.1.2",
  // hrStorageTable (procura tipo "hrStorageRam" = .1.3.6.1.2.1.25.2.1.2)
  hrStorageType: "1.3.6.1.2.1.25.2.3.1.2",
  hrStorageSize: "1.3.6.1.2.1.25.2.3.1.5",
  hrStorageUsed: "1.3.6.1.2.1.25.2.3.1.6",
  hrStorageRam: "1.3.6.1.2.1.25.2.1.2",
  // ifTable / ifXTable
  ifIndex: "1.3.6.1.2.1.2.2.1.1",
  ifDescr: "1.3.6.1.2.1.2.2.1.2",
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  ifAdminStatus: "1.3.6.1.2.1.2.2.1.7",
  ifInErrors: "1.3.6.1.2.1.2.2.1.14",
  ifOutErrors: "1.3.6.1.2.1.2.2.1.20",
  ifName: "1.3.6.1.2.1.31.1.1.1.1",
  ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15", // Mbps
  ifAlias: "1.3.6.1.2.1.31.1.1.1.18",
  ifHCInOctets: "1.3.6.1.2.1.31.1.1.1.6",
  ifHCOutOctets: "1.3.6.1.2.1.31.1.1.1.10",
  ifInOctets: "1.3.6.1.2.1.2.2.1.10",
  ifOutOctets: "1.3.6.1.2.1.2.2.1.16",
};

const OPER_STATUS = { 1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "notPresent", 7: "lowerLayerDown" };
const ADMIN_STATUS = { 1: "up", 2: "down", 3: "testing" };

function buildSession(target, cfg) {
  const opts = {
    port: cfg.port ?? 161,
    timeout: cfg.timeout_ms ?? 3000,
    retries: cfg.retries ?? 2,
    version: cfg.version === "v3" ? snmp.Version3 : snmp.Version2c,
  };
  if (cfg.version === "v3") {
    const user = {
      name: cfg.username,
      level: snmp.SecurityLevel.noAuthNoPriv,
    };
    if (cfg.auth_proto && cfg.auth_proto !== "none") {
      user.level = snmp.SecurityLevel.authNoPriv;
      user.authProtocol = cfg.auth_proto === "SHA" ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5;
      user.authKey = cfg.auth_password;
    }
    if (cfg.priv_proto && cfg.priv_proto !== "none") {
      user.level = snmp.SecurityLevel.authPriv;
      user.privProtocol = cfg.priv_proto === "AES" ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des;
      user.privKey = cfg.priv_password;
    }
    return snmp.createV3Session(target, user, opts);
  }
  return snmp.createSession(target, cfg.community ?? "public", opts);
}

function getAsync(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      const errored = varbinds.find((v) => snmp.isVarbindError(v));
      if (errored) return reject(new Error(snmp.varbindError(errored)));
      resolve(varbinds);
    });
  });
}

function subtreeAsync(session, oid, maxRows = 500) {
  return new Promise((resolve, reject) => {
    const out = [];
    let settled = false;
    const finish = (partialReason = null, err = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(optionalTimeout);
      if (err) return reject(err);
      if (partialReason) {
        out.partial = { oid, reason: partialReason, rows: out.length };

      }
      resolve(out);
    };
    const optionalTimeout = setTimeout(() => finish("timeout"), 6000);
    session.subtree(
      oid,
      20, // maxRepetitions
      (varbinds) => {
        // net-snmp stops the walk when the feed callback returns true.
        // A timed-out walk stops at its next response; never append late rows.
        if (settled) return true;
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) {
            if (vb.type === snmp.ObjectType.NoSuchObject || vb.type === snmp.ObjectType.NoSuchInstance) out.unsupported = true;
            continue;
          }
          out.push(vb);
          if (out.length >= maxRows) {
            finish("row_limit");
            return true;
          }
        }
        return false;
      },
      (err) => finish(null, err),
    );
  });
}

function tailIndex(oid, prefix) {
  return oid.startsWith(prefix + ".") ? oid.slice(prefix.length + 1) : null;
}

// Preserve failed walks as partial: never mistake timeout/error for lack of HC support.
async function counterWalk(session, oid) {
  try { return await subtreeAsync(session, oid); }
  catch (err) {
    const rows = [];
    const unsupported = /NoSuchObject|NoSuchInstance/i.test(String(err.message));
    if (unsupported) rows.unsupported = true;
    else rows.partial = { oid, reason: "query_error", rows: 0 };
    return rows;
  }
}

// ---------- Coleta principal ----------
export async function collectSnmp(target, cfg) {
  const session = buildSession(target, cfg);
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { try { session.close(); } catch {} reject(new Error("SNMP: timeout total 29000ms")); }, 29000);
  });
  try {
    return await Promise.race([expired, (async () => {
    const sysVarbinds = await getAsync(session, [OID.sysUpTime]);
    // Optional unsupported OIDs do not invalidate a valid sysUpTime response.
    const [cpuRows, memTypes, memSizes, memUsed] = await Promise.all([
      subtreeAsync(session, OID.hrProcessorLoad).catch(() => []),
      subtreeAsync(session, OID.hrStorageType).catch(() => []),
      subtreeAsync(session, OID.hrStorageSize).catch(() => []),
      subtreeAsync(session, OID.hrStorageUsed).catch(() => []),
    ]);

    // sysUpTime vem em centésimos de segundo (TimeTicks)
    const upTicks = Number(sysVarbinds?.[0]?.value);
    if (!Number.isFinite(upTicks)) throw new Error("SNMP: sem resposta válida de sysUpTime");
    const uptime_seconds = Math.round(upTicks / 100);

    // CPU: média entre cores
    let cpu_load = null;
    if (cpuRows.length) {
      const vals = cpuRows.map((v) => Number(v.value)).filter((n) => !Number.isNaN(n));
      if (vals.length) cpu_load = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    // Memória: localiza linhas onde type = hrStorageRam, soma used/size
    let memory_used_pct = null;
    if (memTypes.length && memSizes.length && memUsed.length) {
      const ramIndexes = memTypes
        .filter((vb) => Array.isArray(vb.value) ? false : String(vb.value) === OID.hrStorageRam || (vb.value?.toString?.() ?? "") === OID.hrStorageRam)
        .map((vb) => tailIndex(vb.oid, OID.hrStorageType))
        .filter(Boolean);
      // Fallback: se a comparação acima não pegar (RouterOS retorna OID como string), tenta match de prefixo
      const ramIdxSet = new Set(
        ramIndexes.length ? ramIndexes : memTypes
          .filter((vb) => (vb.value?.toString?.() ?? "").includes("25.2.1.2"))
          .map((vb) => tailIndex(vb.oid, OID.hrStorageType))
          .filter(Boolean),
      );
      const sizeMap = new Map(memSizes.map((vb) => [tailIndex(vb.oid, OID.hrStorageSize), Number(vb.value)]));
      const usedMap = new Map(memUsed.map((vb) => [tailIndex(vb.oid, OID.hrStorageUsed), Number(vb.value)]));
      let totSize = 0, totUsed = 0;
      for (const idx of ramIdxSet) {
        const s = sizeMap.get(idx) ?? 0;
        const u = usedMap.get(idx) ?? 0;
        if (s > 0) { totSize += s; totUsed += u; }
      }
      if (totSize > 0) memory_used_pct = Math.round((totUsed / totSize) * 100);
    }

    // Interfaces (em paralelo)
    const [ifNames, ifAliases, ifSpeeds, ifOpers, ifAdmins, ifInErr, ifOutErr, ifInOct, ifOutOct, ifDescrs, in32Rows, out32Rows] =
      await Promise.all([
        subtreeAsync(session, OID.ifName).catch(() => []),
        subtreeAsync(session, OID.ifAlias).catch(() => []),
        subtreeAsync(session, OID.ifHighSpeed).catch(() => []),
        subtreeAsync(session, OID.ifOperStatus).catch(() => []),
        subtreeAsync(session, OID.ifAdminStatus).catch(() => []),
        subtreeAsync(session, OID.ifInErrors).catch(() => []),
        subtreeAsync(session, OID.ifOutErrors).catch(() => []),
        counterWalk(session, OID.ifHCInOctets),
        counterWalk(session, OID.ifHCOutOctets),
        subtreeAsync(session, OID.ifDescr).catch(() => []),
      ]);

    const indexed = (rows, base) => {
      const m = new Map();
      for (const vb of rows) {
        const idx = tailIndex(vb.oid, base);
        if (idx != null) m.set(idx, vb.value);
      }
      return m;
    };

    const nameByIdx = indexed(ifNames, OID.ifName);
    const descrByIdx = indexed(ifDescrs, OID.ifDescr);
    const aliasByIdx = indexed(ifAliases, OID.ifAlias);
    const speedByIdx = indexed(ifSpeeds, OID.ifHighSpeed);
    const operByIdx = indexed(ifOpers, OID.ifOperStatus);
    const adminByIdx = indexed(ifAdmins, OID.ifAdminStatus);
    const inErrByIdx = indexed(ifInErr, OID.ifInErrors);
    const outErrByIdx = indexed(ifOutErr, OID.ifOutErrors);
    const inOctByIdx = indexed(ifInOct, OID.ifHCInOctets);
    const outOctByIdx = indexed(ifOutOct, OID.ifHCOutOctets);

    const allIdx = new Set([...nameByIdx.keys(), ...descrByIdx.keys(), ...operByIdx.keys(), ...inOctByIdx.keys(), ...outOctByIdx.keys()]);
    // Completed HC walks missing an interface establish that HC is unavailable
    // for that index. Failed/partial walks and invalid HC values NEVER fall back.
    const needs32 = (rows, map) => !rows.partial && [...allIdx].some((idx) => !map.has(idx));
    const [in32Rows, out32Rows] = await Promise.all([
      needs32(ifInOct, inOctByIdx) ? counterWalk(session, OID.ifInOctets) : [],
      needs32(ifOutOct, outOctByIdx) ? counterWalk(session, OID.ifOutOctets) : [],
    ]);
    const in32ByIdx = indexed(in32Rows, OID.ifInOctets);
    const out32ByIdx = indexed(out32Rows, OID.ifOutOctets);
    const counter_diagnostics = { received: 0, absent: 0, invalid: 0, fallback32: 0, partial: 0 };
    function counter(idx, hcRows, hcMap, lowRows, lowMap) {
      let raw = hcMap.get(idx), bits = 64;
      if (!hcMap.has(idx) && !hcRows.partial && lowMap.has(idx)) {
        raw = lowMap.get(idx); bits = 32;
      }
      if (raw == null) { counter_diagnostics.absent++; return { value: null, bits: null }; }
      counter_diagnostics.received++;
      const value = toNum(raw);
      if (value == null || (bits === 32 && value > 0xffffffff)) {
        counter_diagnostics.invalid++; return { value: null, bits: null };
      }
      if (bits === 32) counter_diagnostics.fallback32++;
      return { value, bits };
    }
    const interfaces = [];
    for (const idx of allIdx) {
      const if_index = Number(idx);
      if (!Number.isFinite(if_index)) continue;
      const oper = Number(operByIdx.get(idx));
      const admin = Number(adminByIdx.get(idx));
      const speedMbps = Number(speedByIdx.get(idx) ?? 0);
      const incoming = counter(idx, ifInOct, inOctByIdx, in32Rows, in32ByIdx);
      const outgoing = counter(idx, ifOutOct, outOctByIdx, out32Rows, out32ByIdx);
      interfaces.push({
        if_index,
        if_name: bufToStr(nameByIdx.get(idx)) ?? null,
        if_descr: bufToStr(descrByIdx.get(idx)) ?? null,
        if_alias: bufToStr(aliasByIdx.get(idx)) ?? null,
        if_speed_bps: speedMbps > 0 ? speedMbps * 1_000_000 : null,
        oper_status: OPER_STATUS[oper] ?? null,
        admin_status: ADMIN_STATUS[admin] ?? null,
        in_octets: incoming.value,
        out_octets: outgoing.value,
        in_counter_bits: incoming.bits,
        out_counter_bits: outgoing.bits,
        in_errors: toNum(inErrByIdx.get(idx)),
        out_errors: toNum(outErrByIdx.get(idx)),
      });
    }

    const partial_walks = [cpuRows, memTypes, memSizes, memUsed,
      ifNames, ifAliases, ifSpeeds, ifOpers, ifAdmins, ifInErr, ifOutErr, ifInOct, ifOutOct, ifDescrs, in32Rows, out32Rows]
      .filter((rows) => rows.partial).map((rows) => rows.partial);
    counter_diagnostics.partial = partial_walks.length;
    return { counter_diagnostics, snmp_valid: true, uptime_seconds, cpu_load, memory_used_pct, interfaces,
      snmp_partial: partial_walks.length > 0, partial_walks };
    })()]);
  } finally {
    clearTimeout(timer);
    try { session.close(); } catch { /* noop */ }
  }
}

function bufToStr(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v);
}
function toNum(v) {
  if (v == null) return null;
  // Counter64 is unsigned binary big-endian, never decimal UTF-8.
  if (Buffer.isBuffer(v)) {
    if (v.length < 1 || v.length > 8) return null;
    if (v.length === 8) v = v.readBigUInt64BE(0);
    else {
      let unsigned = 0n;
      for (const byte of v) unsigned = (unsigned << 8n) | BigInt(byte);
      v = unsigned;
    }
  }
  if (typeof v === "bigint") {
    // Numbers cannot represent larger counters exactly: omit rather than
    // introduce rounded counters into traffic deltas. Zero remains valid.
    if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
