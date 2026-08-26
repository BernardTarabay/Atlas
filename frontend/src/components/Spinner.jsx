import { Loader2 } from "lucide-react";

export function Spinner({ size = 18, className = "" }) {
  return <Loader2 size={size} className={`animate-spin text-brand-600 ${className}`} />;
}

export function PageSpinner() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner size={28} />
    </div>
  );
}
