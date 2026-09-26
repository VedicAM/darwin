/**
 * Client for the Rust harness bridge.
 *
 * Pi has no execution and no network tools. When an extension needs the harness
 * to *do* something — run an experiment, fold a sequence — it sends one JSON
 * line over the Unix domain socket the Rust side opened, and reads one JSON
 * line back. This is the channel `bridge.rs` documents: a transport, not a back
 * door. Every request still goes through `Harness::execute`, so the registry
 * invariant holds identically to a webview `invoke`.
 *
 * `pi.rs` flagged migrating the search tools onto this socket as the obvious
 * next step; this is the first extension to use it, for `experiment.run`, where
 * there is no alternative — the code must run in the harness, never in Pi.
 *
 * No Pi imports here, so the logic is unit-testable with `node --test`.
 */

import { createConnection } from "node:net";

/** Environment variable the Rust side sets on the Pi child (`bridge.rs`). */
export const SOCKET_ENV = "DARWIN_HARNESS_SOCKET";

/** A structured failure, so a caller can tell a transport error from a refusal. */
export class HarnessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarnessError";
	}
}

/**
 * Send one capability request and return its `result` payload.
 *
 * `request` must already carry its `capability` tag, e.g.
 * `{ capability: "experiment.run", code, inputs, timeout_s }`. Resolves with the
 * result object on success; rejects with a `HarnessError` on any failure,
 * because a resolved-but-empty result is exactly the "found nothing" / "the call
 * failed" confusion the bridge is built to avoid.
 */
export function callHarness(
	request: Record<string, unknown>,
	opts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
	const env = opts.env ?? process.env;
	const socketPath = env[SOCKET_ENV];
	if (!socketPath) {
		return Promise.reject(
			new HarnessError(
				`${SOCKET_ENV} is not set; the harness socket is unavailable, so the ` +
					`capability cannot be reached`,
			),
		);
	}

	return new Promise((resolve, reject) => {
		// The bridge sets its own 30s read/write timeouts; this guards the
		// client against a bridge that accepts and never answers.
		const timeoutMs = opts.timeoutMs ?? 320_000;
		let settled = false;
		const chunks: Buffer[] = [];

		const socket = createConnection(socketPath);
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const fail = (msg: string) => done(() => reject(new HarnessError(msg)));

		const timer = setTimeout(() => fail(`harness call timed out after ${timeoutMs}ms`), timeoutMs);
		const onAbort = () => fail("harness call was aborted");
		if (opts.signal) {
			if (opts.signal.aborted) return onAbort();
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		socket.on("connect", () => {
			// One request line, then half-close so the bridge sees EOF and reads
			// exactly one line.
			socket.end(JSON.stringify(request) + "\n");
		});
		socket.on("data", (buf: Buffer) => chunks.push(buf));
		socket.on("error", (err) => fail(`could not reach the harness socket: ${err.message}`));
		socket.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (!raw) return fail("harness closed the connection without a reply");
			let reply: Record<string, unknown>;
			try {
				reply = JSON.parse(raw.split("\n")[0]);
			} catch (err) {
				return fail(`harness reply was not valid JSON: ${(err as Error).message}`);
			}
			// `BridgeReply` is serde-tagged on `ok`: the discriminant is the
			// string "ok" / "error" (accept a boolean too, defensively).
			const ok = reply.ok === "ok" || reply.ok === true;
			if (ok) return done(() => resolve(reply.result));
			const error = typeof reply.error === "string" ? reply.error : "unknown harness error";
			return fail(error);
		});
	});
}
