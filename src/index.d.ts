export type FindingSeverity = "error" | "warning" | "info";

export interface ScriptFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  suggestion?: string;
  script?: string;
  command?: string;
  target?: string;
}

export interface InspectionReport {
  projectDirectory: string;
  packageFile: string;
  packageName: string | null;
  scriptsChecked: number;
  fatal: boolean;
  findings: ScriptFinding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
}

/** Inspect a project's package.json scripts without executing shell commands. */
export function inspectProject(projectPath?: string): Promise<InspectionReport>;
