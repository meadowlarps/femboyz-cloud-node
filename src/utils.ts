import { scope } from "./logger.js"

const utilsLogger = scope("utils")

export function shutdownUnexpectedly() {
    utilsLogger.error("Shutting down unexpectedly...")
    process.exit(1)
}
