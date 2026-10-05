/**
 * A token for git, as an http extraheader in the environment of ONE git call
 * — never in a URL, where an error message could echo it, and never in
 * .git/config, where a later step could read it. The same pattern as
 * post-merge-regen's `land` (its land.mjs), copied rather than imported so
 * the two actions stay independent.
 */
import { git } from "./git.mjs";

export function authEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** `text` with every secret, and its extraheader form, replaced by `***`. */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("***");
    out = out.split(Buffer.from(`x-access-token:${secret}`).toString("base64")).join("***");
  }
  return out;
}

/**
 * The read token for a fetch, only when the checkout carries no credential of
 * its own: a second Authorization header next to a persisted one would be
 * sent too. The restack workflow checks out with `persist-credentials: false`.
 */
export function readAuthEnv(token, cwd) {
  const { out } = git(["config", "--get-regexp", "^http\\..*\\.extraheader$"], { cwd, ok: [0, 1] });
  return out.trim() ? {} : authEnv(token);
}
