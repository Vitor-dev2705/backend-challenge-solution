export class DomainError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = 'DomainError'; }
}
