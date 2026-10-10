// RFC 9457 problem details (packages/contracts: Problem). Throw from any handler.
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }
}
