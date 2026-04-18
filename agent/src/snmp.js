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
    session.subtree(
      oid,
      20, // maxRepetitions
      (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          out.push(vb);
          if (out.length >= maxRows) return false;
        }
      },
      (err) => (err ? reject(err) : resolve(out)),
    );
  });
}

function tailIndex(oid, prefix) {
  return oid.startsWith(prefix + ".") ? oid.slice(prefix.length + 1) : null;
}

// ---------- Coleta principal ----------
export async function collectSnmp(target, cfg) {
  const session = buildSession(target, cfg);
  try {
    // Sistema (em paralelo)
    const [sysVarbinds, cpuRows, memTypes, memSizes, memUsed] = await Promise.all([
      getAsync(session, [OID.sysUpTime]).catch(() => []),
      subtreeAsync(session, OID.hrProcessorLoad).catch(() => []),
      subtreeAsync(session, OID.hrStorageType).catch(() => []),
      subtreeAsync(session, OID.hrStorageSize).catch(() => []),
      subtreeAsync(session, OID.hrStorageUsed).catch(() => []),
    ]);

    // sysUpTime vem em centésimos de segundo (TimeTicks)
    const upTicks = Number(sysVarbinds?.[0]?.value ?? 0);
    const uptime_seconds = upTicks ? Math.round(upTicks / 100) : null;

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
    const [ifNames, ifAliases, ifSpeeds, ifOpers, ifAdmins, ifInErr, ifOutErr, ifInOct, ifOutOct, ifDescrs] =
      await Promise.all([
        subtreeAsync(session, OID.ifName).catch(() => []),
        subtreeAsync(session, OID.ifAlias).catch(() => []),
        subtreeAsync(session, OID.ifHighSpeed).catch(() => []),
        subtreeAsync(session, OID.ifOperStatus).catch(() => []),
        subtreeAsync(session, OID.ifAdminStatus).catch(() => []),
        subtreeAsync(session, OID.ifInErrors).catch(() => []),
        subtreeAsync(session, OID.ifOutErrors).catch(() => []),
        subtreeAsync(session, OID.ifHCInOctets).catch(() => []),
        subtreeAsync(session, OID.ifHCOutOctets).catch(() => []),
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

    const allIdx = new Set([...nameByIdx.keys(), ...descrByIdx.keys(), ...inOctByIdx.keys()]);
    const interfaces = [];
    for (const idx of allIdx) {
      const if_index = Number(idx);
      if (!Number.isFinite(if_index)) continue;
      const oper = Number(operByIdx.get(idx));
      const admin = Number(adminByIdx.get(idx));
      const speedMbps = Number(speedByIdx.get(idx) ?? 0);
      interfaces.push({
        if_index,
        if_name: bufToStr(nameByIdx.get(idx)) ?? null,
        if_descr: bufToStr(descrByIdx.get(idx)) ?? null,
        if_alias: bufToStr(aliasByIdx.get(idx)) ?? null,
        if_speed_bps: speedMbps > 0 ? speedMbps * 1_000_000 : null,
        oper_status: OPER_STATUS[oper] ?? null,
        admin_status: ADMIN_STATUS[admin] ?? null,
        in_octets: toNum(inOctByIdx.get(idx)),
        out_octets: toNum(outOctByIdx.get(idx)),
        in_errors: toNum(inErrByIdx.get(idx)),
        out_errors: toNum(outErrByIdx.get(idx)),
      });
    }

    return { uptime_seconds, cpu_load, memory_used_pct, interfaces };
  } finally {
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
  // net-snmp pode retornar BigInt para Counter64
  if (typeof v === "bigint") return Number(v);
  if (Buffer.isBuffer(v)) return Number(v.toString());
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
