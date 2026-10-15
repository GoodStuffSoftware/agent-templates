// usage/report.mjs: the dated report and the 3-line summary of the daily usage analysis
// (design section 4, "Outputs"). Pure: a results object in, text out. No clock, no I/O, no
// machine paths, so a re-render of the same results is byte-identical.
//
// The run's own cost (duration, bytes read, RSS) is deliberately NOT in the report: it would make a
// forced recompute differ from the first one. It lives in state/usage-analysis-status.json.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (x) => typeof x === 'number' && Number.isFinite(x);

export const r2 = (x) => Math.round(x * 100) / 100;
export const r4 = (x) => Math.round(x * 10000) / 10000;

export function fmt(x, digits = 2) {
  if (!num(x)) return 'n/a';
  const f = 10 ** digits;
  return String(Math.round(x * f) / f);
}

const signed = (x, digits = 1) => (num(x) ? `${x >= 0 ? '+' : ''}${fmt(x, digits)}` : 'n/a');
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const mmdd = (day) => String(day).slice(5);

// ------------------------------------------------------------- regressions --

/** The alert scenarios (or groups) that regressed on the day: [{ id, group?, compare, value, baseline, relPct, n, label, interval }]. */
export function regressionsOf(scenarios, severity = 'alert') {
  const out = [];
  for (const sc of scenarios || []) {
    if (!isObj(sc) || sc.severity !== severity) continue;
    const take = (cmps, group) => {
      for (const c of cmps || []) {
        if (!isObj(c) || c.status !== 'regression') continue;
        out.push({
          id: sc.id,
          ...(group !== undefined ? { group } : {}),
          compare: c.compare,
          value: c.current ? c.current.value : null,
          baseline: c.baseline ? c.baseline.value : null,
          relPct: c.relPct ?? null,
          n: c.current ? c.current.sample : null,
          label: c.label === 'E' ? 'E' : 'M',
          interval: c.interval && c.interval.applied ? c.interval.kind : 'none',
        });
      }
    };
    take(sc.comparisons);
    for (const g of sc.groups || []) take(g.comparisons, g.key);
  }
  return out;
}

/** Info-severity scenarios with a comparison at status regression: named in the summary and the report, never paged (no scout signal). */
export const infoRegressionsOf = (scenarios) => regressionsOf(scenarios, 'info');

export const regressionIdsOf = (regs) => [...new Set(regs.map((r) => r.id))].sort();

// ----------------------------------------------------------------- summary --

/** Lines 1 and 2 of the summary (line 3, the report path, is added by whoever knows the path). */
export function summaryLines(res) {
  const t = res.totals;
  const w = res.week;
  const parts = [];
  if (t && num(t.units)) {
    parts.push(`${fmt(t.units, 1)} u = ${fmt(t.pctOfWeeklyLimit, 1)}% of week (${t.shareEstimated > 0 ? 'M+E' : 'M'})`);
  } else parts.push('no total (n/a)');
  if (w && num(w.pctSoFar)) parts.push(`week ${fmt(w.pctSoFar, 1)}% at ${fmt(w.elapsedPct, 0)}% elapsed (M)`);
  const v = res.vsTrailing7;
  if (v && num(v.pct)) parts.push(`vs trailing-7 ${signed(v.pct, 0)}% (M)`);
  else if (v && v.why) parts.push('vs trailing-7 n/a (too few days)');
  const line1 = `[agent-companion] usage ${mmdd(res.day)}: ${parts.join(' | ')}`;

  const regs = res.regressions || [];
  // One rule: a comparison at status "regression" is counted. Alert-severity ones page (regressionIds); info-severity
  // ones are counted separately here and in the report, so the line never says "none" while one exists.
  const infoIds = regressionIdsOf(infoRegressionsOf(res.scenarios));
  const infoNote = infoIds.length
    ? `${infoIds.length} info-severity (not paged): ${infoIds.slice(0, 3).join(', ')}${infoIds.length > 3 ? `, +${infoIds.length - 3} more` : ''}`
    : '';
  let line2;
  if (!regs.length) {
    // "none" is only an answer when something was evaluated: a day on which every scenario was a gap says so instead.
    const scs = res.scenarios || [];
    const isGap = (s) => s.skipped === 'gap' || s.status === 'gap' || s.status === 'no-data';
    const gapN = scs.filter(isGap).length;
    const evalN = scs.filter((s) => !s.skipped && !isGap(s)).length;
    const gapNote = `${gapN} gap${gapN === 1 ? '' : 's'}`;
    if (evalN === 0) line2 = `regressions: n/a (0 scenarios evaluated${scs.length ? `, ${gapNote}` : ''})`;
    else if (infoNote) line2 = `regressions: none at alert severity; ${infoNote} (${evalN} scenario${evalN === 1 ? '' : 's'} evaluated, ${gapNote})`;
    else line2 = `regressions: none (${evalN} scenario${evalN === 1 ? '' : 's'} evaluated, ${gapNote})`;
  } else {
    const items = regs.slice(0, 3).map((r) => {
      const who = r.group !== undefined ? `${r.id}[${r.group}]` : r.id;
      return `${who} ${fmt(r.value)} vs ${fmt(r.baseline)} ${r.compare} (${signed(r.relPct, 0)}%, n=${fmt(r.n, 0)}, ${r.label}${r.interval !== 'none' ? '-int' : ''})`;
    });
    line2 = `regressions: ${items.join(' ; ')}${regs.length > 3 ? ` ; +${regs.length - 3} more` : ''}${infoNote ? ` ; also ${infoNote}` : ''}`;
  }
  return [line1, line2];
}

// ------------------------------------------------------------------ report --

const why = (c) => c.why || (c.interval && c.interval.why) || '';

function scenarioRows(sc) {
  const rows = [];
  const push = (group, c) => {
    const cur = c.current; const bas = c.baseline;
    rows.push(`| ${cell(sc.id)} | ${cell(group ?? '')} | ${cell(c.compare)} | ${cell(c.status)} | ${cur ? fmt(cur.value) : 'n/a'} | ${bas ? fmt(bas.value) : 'n/a'} | ${signed(c.delta, 2)} | ${signed(c.relPct, 1)} | ${cur ? fmt(cur.sample, 0) : 'n/a'} | ${c.interval && c.interval.applied ? c.interval.kind : 'none'} | ${c.label || 'M'} | ${cell(why(c))} |`);
  };
  for (const c of sc.comparisons || []) push(undefined, c);
  for (const g of sc.groups || []) for (const c of g.comparisons || []) push(g.key, c);
  return rows;
}

// {name: n} (records the exclusion could not be judged on) as "name: n, ..."; also accepts a list of names or {name} items; '' when none.
function unobservableText(u) {
  if (!u) return '';
  if (Array.isArray(u)) return u.map((x) => (x && typeof x === 'object' ? `${x.name ?? x.id ?? ''}${x.n !== undefined ? `: ${x.n}` : ''}` : String(x))).filter(Boolean).join(', ');
  if (typeof u === 'object') return Object.keys(u).sort().map((k) => `${k}: ${u[k]}`).join(', ');
  return String(u);
}

export function renderReport(res) {
  const L = [];
  const t = res.totals || {};
  L.push(`# Usage ${res.day} (revision ${res.revision})`);
  L.push('');
  L.push(`Day ${res.day}, ${res.facts.from} to ${res.facts.to}. Data through ${res.facts.dataThrough || 'unknown'}; scan from ${res.facts.scanFrom || 'unknown'}.`);
  L.push(`Versions: runner ${res.runnerVersion}, facts ${res.facts.factsVersion}, extractor ${res.facts.extractorVersion}. inputsDigest ${res.inputsDigest}.`);
  L.push('');
  L.push('## Summary');
  L.push('');
  for (const l of res.summary.lines) L.push(`- ${l}`);
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push('| what | units | % of weekly limit | label |');
  L.push('|---|---|---|---|');
  L.push(`| day, all sessions | ${fmt(t.units, 1)} | ${fmt(t.pctOfWeeklyLimit, 2)} | ${t.shareEstimated > 0 ? 'M+E' : 'M'} |`);
  L.push(`| main threads | ${fmt(t.main, 1)} | ${fmt(t.limitUnits > 0 ? (t.main / t.limitUnits) * 100 : null, 2)} | M |`);
  L.push(`| workers | ${fmt(t.subagent, 1)} | ${fmt(t.limitUnits > 0 ? (t.subagent / t.limitUnits) * 100 : null, 2)} | M |`);
  L.push('');
  L.push(`Weekly limit ${fmt(t.limitUnits, 0)} units. ${t.sessions} sessions, ${t.spawns} worker spawns. Share of the day's units priced at estimated (E) weights: ${fmt(t.shareEstimated, 1)}%.`);
  if (res.week) L.push(`Week to date ${fmt(res.week.pctSoFar, 1)}% at ${fmt(res.week.elapsedPct, 1)}% of the week elapsed; pace at reset ${fmt(res.week.paceAtResetPct, 1)}%${res.week.partial ? ' (week started before the scan; partial)' : ''}.`);
  else L.push('Week to date: not available (no checkup history record for the day).');
  if (res.vsTrailing7 && num(res.vsTrailing7.pct)) L.push(`Day total against the mean of the previous ${res.vsTrailing7.days} settled days: ${signed(res.vsTrailing7.pct, 1)}%.`);
  else L.push(`Day total against trailing-7: n/a (${(res.vsTrailing7 && res.vsTrailing7.why) || 'no baseline'}).`);
  L.push('');
  L.push('Weights');
  L.push('');
  L.push('| model | weight | source | label | units |');
  L.push('|---|---|---|---|---|');
  for (const m of Object.keys(res.weights || {}).sort()) {
    const w = res.weights[m];
    L.push(`| ${cell(m)} | ${fmt(w.mult)} | ${cell(w.source)} | ${w.label || '?'} | ${fmt(w.units, 1)} |`);
  }
  L.push('');
  L.push('## Regressions');
  L.push('');
  const tbl = (rows) => {
    L.push('| scenario | group | comparison | value | baseline | change % | n | interval | label |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) L.push(`| ${cell(r.id)} | ${cell(r.group ?? '')} | ${cell(r.compare)} | ${fmt(r.value)} | ${fmt(r.baseline)} | ${signed(r.relPct, 1)} | ${fmt(r.n, 0)} | ${r.interval} | ${r.label} |`);
  };
  const infoRegs = infoRegressionsOf(res.scenarios);
  if (!(res.regressions || []).length) L.push(infoRegs.length ? 'None at alert severity.' : 'None.');
  else tbl(res.regressions);
  if (infoRegs.length) {
    L.push('');
    L.push('Info-severity scenarios at status regression (reported, not paged):');
    L.push('');
    tbl(infoRegs);
  }
  L.push('');
  L.push('## Scenarios');
  L.push('');
  L.push('| scenario | group | comparison | status | value | baseline | delta | change % | n | interval | label | note |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const skipped = [];
  for (const sc of res.scenarios || []) {
    if (sc.skipped) { skipped.push(sc); continue; }
    const rows = scenarioRows(sc);
    if (rows.length) L.push(...rows);
    else L.push(`| ${cell(sc.id)} |  |  | ${cell(sc.status || 'no-data')} |  |  |  |  |  |  | ${sc.label || 'M'} | no comparison defined |`);
  }
  L.push('');
  L.push('## Exclusions');
  L.push('');
  const ex = res.exclusions;
  if (!ex || !ex.rows || !ex.rows.length) L.push('None applied.');
  else {
    L.push('| exclusion | scope | records | units | % of weekly limit | why |');
    L.push('|---|---|---|---|---|---|');
    for (const e of ex.rows) L.push(`| ${cell(e.name)} | ${cell(e.scope)} | ${fmt(e.records, 0)} | ${fmt(e.units, 1)} | ${fmt(e.pctOfWeeklyLimit, 2)} | ${cell(e.why)} |`);
    const unobs = unobservableText(ex.unobservable);
    if (unobs) L.push('', `Records an exclusion could not be judged on (unobservable, so not excluded): ${unobs}.`);
  }
  L.push('');
  L.push('## Windows');
  L.push('');
  const wnames = Object.keys(res.windows || {}).sort();
  if (!wnames.length) L.push('None defined.');
  else {
    L.push('| window | state | from | to | label |');
    L.push('|---|---|---|---|---|');
    for (const n of wnames) {
      const w = res.windows[n];
      if (w.gap) L.push(`| ${cell(n)} | unresolved: ${cell(w.why)} |  |  |  |`);
      else L.push(`| ${cell(n)} | ${w.state} | ${w.from} | ${w.to || 'open'} | ${w.label} |`);
    }
  }
  L.push('');
  L.push('## Unobservable items and gaps');
  L.push('');
  const gaps = res.gaps || [];
  if (!gaps.length && !skipped.length) L.push('None.');
  else {
    for (const g of gaps) L.push(`- ${cell(g.id)}: ${cell(g.why)}`);
    for (const s of skipped) if (!gaps.some((g) => g.id === s.id)) L.push(`- ${cell(s.id)}: ${cell(s.skipped)}${s.why ? ` (${cell(s.why)})` : ''}`);
  }
  L.push('');
  L.push('## Revisions');
  L.push('');
  for (const r of res.revisions || []) L.push(`- revision ${r.revision}: ${cell(r.reason)}`);
  L.push('');
  L.push('Run cost (duration, bytes read, peak memory, LLM units) is in state/usage-analysis-status.json.');
  L.push('');
  return `${L.join('\n')}`;
}
