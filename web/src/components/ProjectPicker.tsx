import { Repo } from "../api";

export default function ProjectPicker({
  projects,
  selectedProject,
  onSelectProject,
  repos,
  selectedRepo,
  onSelectRepo,
}: {
  projects: { name: string }[];
  selectedProject: string;
  onSelectProject: (name: string) => void;
  repos: Repo[];
  selectedRepo: string;
  onSelectRepo: (name: string) => void;
}) {
  return (
    <>
      <select value={selectedProject} onChange={(e) => onSelectProject(e.target.value)}>
        {projects.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      <select value={selectedRepo} onChange={(e) => onSelectRepo(e.target.value)}>
        <option value="">All repos</option>
        {repos.map((r) => (
          <option key={r.name} value={r.name}>
            {r.name} ({r.entities})
          </option>
        ))}
      </select>
    </>
  );
}
