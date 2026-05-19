export class ServiceError extends Error {
  data?: Record<string, unknown>;
  constructor(
    public statusCode: number,
    message: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.data = data;
  }
}
