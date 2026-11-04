export function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="page">
      <div className="empty">
        <div className="panel-title">{title}</div>
        <div style={{ maxWidth: 520 }}>{text}</div>
      </div>
    </div>
  );
}
