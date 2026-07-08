/**
 * The flight skill — a plain GitHub repo URL, installed by the relay (cctools skills v3) via
 * `skills add`, which installs ALL skills under the repo (currently just simplifly-flyai-skill, in
 * skills/simplifly-flyai-skill/ → lands at ~/.claude/skills/simplifly-flyai-skill). Stored/edited/
 * displayed WITHOUT the `github:` prefix so a user just copy-pastes a normal GitHub URL; `toSkillRef`
 * adds the `github:` routing tag the /v1 `skills` param needs, right before we send it (the relay
 * strips that tag and hands the URL verbatim to `skills add`, so a failure is a `skills add` failure).
 *
 * Private repo (TravelKit-AI org) → the relay clones it with the org's GitHub token (bound in the
 * rebyte UI; that token must have access to the TravelKit-AI org). Tracking `main`: push to the repo
 * to update; the next new session re-clones — zero travelkit rebuild/redeploy.
 *
 * (To install just ONE skill from a multi-skill repo, paste a `/tree/<branch>/<subdir>` skill-
 * directory URL instead — `skills add` scopes discovery to that subpath.)
 *
 * Shared by the production worker (worker/task-do.ts) and the CLI probes (server/rebyte/*).
 */
export const SKILL_REF = 'https://github.com/TravelKit-AI/simplifly-flyai-skill'

/** Wrap a plain GitHub URL (or `owner/repo` shorthand) into the `/v1` `skills` ref: prepend the
 *  `github:` routing tag unless it's already there. The URL is otherwise untouched — the relay strips
 *  the tag and passes it verbatim to `skills add`. */
export function toSkillRef(url: string): string {
  return url.startsWith('github:') ? url : `github:${url}`
}
