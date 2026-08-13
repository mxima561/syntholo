type ProgressProps = {
  label: string;
  value: number;
  showValue?: boolean;
};

export function Progress({ label, value, showValue = false }: ProgressProps) {
  const boundedValue = Math.max(0, Math.min(100, value));

  return (
    <div className="progress-wrap">
      <div className="progress-label">
        <span>{label}</span>
        {showValue ? <span>{boundedValue}%</span> : null}
      </div>
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={boundedValue}
        className="progress-track"
        role="progressbar"
      >
        <span className="progress-fill" style={{ width: `${boundedValue}%` }} />
      </div>
    </div>
  );
}

