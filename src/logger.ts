import pino from "pino"

const logger = pino({
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "mm-dd HH:MM:ss.l",
            ignore: "pid,hostname,module",
            messageFormat: "[{module}] {msg}"
        }
    }
})

const scopelog = logger.child({ module: "logger" })
scopelog.info("Loaded")

export const scope = (name: string) => logger.child({ module: name })

export default logger