import { test, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function backup(scenario: string, webmail = false) {
    const directory = mkdtempSync(join(tmpdir(), "mail-backup-"))
    const bin = join(directory, "bin")
    const app = join(directory, "app")
    const log = join(directory, "calls")
    mkdirSync(bin)
    mkdirSync(app)
    writeFileSync(join(app, "oidc-jwks.json"), "test signing key")
    writeFileSync(join(directory, "backup.env"), "")
    for (const command of ["docker", "systemctl", "restic"]) {
        writeFileSync(join(bin, command), `#!/bin/sh
printf '%s\\n' '${command} '"$*" >> "$BACKUP_TEST_LOG"
if [ '${command}' = docker ] && [ "$1" = inspect ] && [ "$BACKUP_TEST_WEBMAIL" = true ]; then printf true; fi
if [ '${command}' = systemctl ] && [ "$1" = is-active ] && [ "$BACKUP_TEST_SCENARIO" = inactive ]; then exit 1; fi
if [ '${command}' = docker ] && [ "$1" = exec ]; then
    if [ "$BACKUP_TEST_SCENARIO" = dump_failure ]; then exit 42; fi
    printf archive
fi
if [ '${command}' = restic ] && [ "$1" = backup ] && [ "$BACKUP_TEST_SCENARIO" = snapshot_failure ]; then exit 43; fi
if [ '${command}' = docker ] && [ "$BACKUP_TEST_SCENARIO" = restart_failure ]; then
    case " $* " in *' start stalwart '*) exit 44 ;; esac
fi
`, { mode: 0o755 })
    }
    let source = readFileSync(new URL("../../deploy/mail/backup.sh", import.meta.url), "utf8")
    for (const [key, value] of Object.entries({
        ENV_FILE: join(directory, "backup.env"), COMPOSE: join(directory, "compose.yml"),
        VOLUMES: join(directory, "volumes"), ACCOUNT_BACKUP: join(directory, "accounts"), APP_DIR: app
    })) source = source.replace(new RegExp(`^${key}=.*$`, "m"), `${key}="${value}"`)
    const script = join(directory, "backup.sh")
    writeFileSync(script, source)
    let failed = false
    try {
        execFileSync("/bin/sh", [script], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BACKUP_TEST_LOG: log, BACKUP_TEST_SCENARIO: scenario, BACKUP_TEST_WEBMAIL: String(webmail) },
            stdio: "pipe"
        })
    } catch { failed = true }
    const calls = readFileSync(log, "utf8")
    rmSync(directory, { recursive: true, force: true })
    return { failed, calls }
}

test("account backup pauses both writers before dumping and restarts them", () => {
    const { failed, calls } = backup("success")
    expect(failed).toBe(false)
    expect(calls.indexOf("systemctl stop femboyz-api.service")).toBeLessThan(calls.indexOf("docker exec"))
    expect(calls.indexOf("stop stalwart")).toBeLessThan(calls.indexOf("docker exec"))
    expect(calls).toContain("start stalwart")
    expect(calls).toContain("systemctl start femboyz-api.service")
    expect(calls).toContain("restic forget")
})

test.each(["dump_failure", "snapshot_failure", "restart_failure"])("backup attempts both restarts after %s", scenario => {
    const { failed, calls } = backup(scenario)
    expect(failed).toBe(true)
    expect(calls).toContain("start stalwart")
    expect(calls).toContain("systemctl start femboyz-api.service")
    expect(calls).not.toContain("restic forget")
})

test("backup preserves an intentionally stopped API", () => {
    const { failed, calls } = backup("inactive")
    expect(failed).toBe(false)
    expect(calls).not.toContain("systemctl stop")
    expect(calls).not.toContain("systemctl start")
})

test.each(["success", "dump_failure"])("webmail is paused and restarted during backup %s", scenario => {
    const { failed, calls } = backup(scenario, true)
    expect(failed).toBe(scenario !== "success")
    expect(calls.indexOf("stop webmail")).toBeLessThan(calls.indexOf("systemctl stop femboyz-api.service"))
    expect(calls).toContain("start webmail")
    expect(calls.indexOf("systemctl start femboyz-api.service")).toBeLessThan(calls.indexOf("start webmail"))
})
