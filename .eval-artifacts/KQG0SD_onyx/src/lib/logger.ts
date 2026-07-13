type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type ConsoleMethod = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

const isDevelopment = import.meta.env.DEV;

function shouldEmit(level: LogLevel) {
  return isDevelopment || level === 'warn' || level === 'error';
}

function emit(level: LogLevel, ...args: unknown[]) {
  if (typeof console === 'undefined' || !shouldEmit(level)) {
    return;
  }

  const consoleMethods: ConsoleMethod = console;
  const target = consoleMethods[level] ?? console.warn;
  target(...args);
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', ...args),
  info: (...args: unknown[]) => emit('info', ...args),
  warn: (...args: unknown[]) => emit('warn', ...args),
  error: (...args: unknown[]) => emit('error', ...args),
};

export type Logger = typeof logger;
