import pino from "pino"
import { mkdirSync } from "node:fs"

mkdirSync("./logs", { recursive: true })

export const errorFileLogger = pino(
    { level: "error" },
    pino.destination("./logs/errors.log")
)

const logger = pino({
    level: process.env.LOGLEVEL || "info",
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: process.env.LOGLEVEL === "debug" ? "HH:MM-ss.l" : "mm-dd HH:MM-ss",
            ignore: "pid,hostname,module",
            messageFormat: "[{module}] {msg}"
        }
    }
})

const scopelog = logger.child({ module: "logger" })
scopelog.info("Loaded")

export const scope = (name: string) => logger.child({ module: name })

export default logger
