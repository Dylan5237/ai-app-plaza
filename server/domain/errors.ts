export interface DomainDiagnostic {
  code: string;
  ruleId: string;
  path?: string;
  field?: string;
  line?: number;
  column?: number;
  suggestion: string;
}

export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly diagnostics?: DomainDiagnostic[];

  constructor(statusCode: number, code: string, message: string, diagnostics?: DomainDiagnostic[]) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
