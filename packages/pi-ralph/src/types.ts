export type Status = "todo" | "doing" | "done";

export interface Task {
  id: string;
  project_id: string;
  title: string;
  spec: string;
  prd: string | null;
  priority: number;
  status: Status;
  depends_on: string[];
  verify: string | null;
  created_by: "human" | "ai";
  created_at: string;
  done_at: string | null;
}

export interface ProgressEntry {
  id: number;
  project_id: string;
  task_id: string | null;
  ts: string;
  author: "human" | "ai";
  text: string;
}
