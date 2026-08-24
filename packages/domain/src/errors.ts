export class DomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
