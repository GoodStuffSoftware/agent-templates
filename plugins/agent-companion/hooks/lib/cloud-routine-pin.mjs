// Cloud routine pin rule: "all routines are evaluated and pinned". Pure verdict for a
// RemoteTrigger create/update call. A body that carries job_config must name a model at
// job_config.ccr.session_context.model. Cloud routines have no effort field. Fail open.
import { pinnedIdIn, classifyPinned } from '../../scripts/lib/pinned-model.mjs';

export const DENY_TEXT = 'Cloud routine without a model: job_config.ccr.session_context.model is missing or empty, so the routine would run on whatever default the platform picks. '
  + 'All routines are evaluated and pinned: run /ac recommend for the routine\'s job, then set the model as an alias (sonnet, opus, haiku), '
  + 'and resend it in the whole job_config (an update replaces job_config as a whole). Cloud routines have no effort field, so only the model is pinned.';

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') { try { const j = JSON.parse(body); return j && typeof j === 'object' ? j : null; } catch { return null; } }
  return null;
}

// -> { verdict: 'allow' | 'deny' | 'note', reason?, note? }
export function cloudRoutineVerdict(input) {
  try {
    if (!input || typeof input !== 'object') return { verdict: 'allow' };
    const action = String(input.action || '').toLowerCase();
    if (action !== 'create' && action !== 'update') return { verdict: 'allow' };
    const body = parseBody(input.body);
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'job_config')) return { verdict: 'allow' };
    const jc = parseBody(body.job_config);
    if (!jc) return { verdict: 'allow' };
    const model = jc.ccr && jc.ccr.session_context ? jc.ccr.session_context.model : undefined;
    if (typeof model !== 'string' || !model.trim()) return { verdict: 'deny', reason: DENY_TEXT };
    const id = pinnedIdIn(model);
    if (id) {
      const c = classifyPinned(id);
      const alias = c.alias ? `"${c.alias}"` : 'the alias';
      const why = c.status === 'superseded' ? 'a superseded model' : 'a pin that never follows the next release';
      return { verdict: 'note', note: `Cloud routine model is the full id ${id} (${why}); an alias (${alias}) follows the next release. Use the alias unless there is a stated technical reason.` };
    }
    return { verdict: 'allow' };
  } catch { return { verdict: 'allow' }; }
}
