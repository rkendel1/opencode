export * as ImprovementStats from "./stats.js"

// Exact small-sample statistics. Agent evaluation sets are small (tens of runs), where normal approximations are
// unreliable, so every test here is exact or a score interval.

const logFactorials = [0]
const logFactorial = (n: number) => {
  for (let i = logFactorials.length; i <= n; i++) logFactorials.push(logFactorials[i - 1] + Math.log(i))
  return logFactorials[n]
}
const logChoose = (n: number, k: number) => logFactorial(n) - logFactorial(k) - logFactorial(n - k)

/**
 * One-sided Fisher exact test on the 2×2 table [[a, b], [c, d]], rows = with / without the condition and
 * columns = event / no event. `greater` tests whether the first row has a higher event rate.
 */
export function fisher(a: number, b: number, c: number, d: number, side: "greater" | "less") {
  const row = a + b
  const col = a + c
  const total = a + b + c + d
  const low = Math.max(0, row + col - total)
  const high = Math.min(row, col)
  const probability = (x: number) =>
    Math.exp(logChoose(col, x) + logChoose(total - col, row - x) - logChoose(total, row))
  const range = side === "greater" ? [a, high] : [low, a]
  let sum = 0
  for (let x = range[0]; x <= range[1]; x++) sum += probability(x)
  return Math.min(1, sum)
}

/** Two-sided exact binomial (sign) test of `k` successes in `n` trials against p = 0.5; used for paired data. */
export function signTest(k: number, n: number) {
  if (n === 0) return 1
  const tail = Math.min(k, n - k)
  let sum = 0
  for (let x = 0; x <= tail; x++) sum += Math.exp(logChoose(n, x) - n * Math.LN2)
  return Math.min(1, 2 * sum)
}

/** Wilson score interval for a proportion, 95% by default. */
export function wilson(successes: number, n: number, z = 1.96) {
  if (n === 0) return { low: 0, high: 1 }
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

/** Newcombe's hybrid score interval for the difference of two proportions p1 − p2. */
export function differenceInterval(x1: number, n1: number, x2: number, n2: number) {
  const p1 = n1 === 0 ? 0 : x1 / n1
  const p2 = n2 === 0 ? 0 : x2 / n2
  const first = wilson(x1, n1)
  const second = wilson(x2, n2)
  const estimate = p1 - p2
  return {
    estimate,
    low: estimate - Math.sqrt((p1 - first.low) ** 2 + (second.high - p2) ** 2),
    high: estimate + Math.sqrt((first.high - p1) ** 2 + (p2 - second.low) ** 2),
  }
}

/** Benjamini–Hochberg adjusted p-values, in the input order. */
export function benjaminiHochberg(values: readonly number[]) {
  const order = values.map((value, index) => ({ value, index })).toSorted((left, right) => left.value - right.value)
  const adjusted = Array.from({ length: values.length }, () => 1)
  let running = 1
  for (let rank = order.length; rank >= 1; rank--) {
    const item = order[rank - 1]
    running = Math.min(running, (item.value * order.length) / rank)
    adjusted[item.index] = Math.min(1, running)
  }
  return adjusted
}

export function median(values: readonly number[]) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
