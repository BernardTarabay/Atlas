export function StatCard({ icon: Icon, label, value, trend, accent = "brand" }) {
  const accents = {
    brand: "from-brand-500/20 to-brand-700/5 text-brand-700",
    cyan: "from-accent-cyan/20 to-accent-cyan/5 text-accent-cyan",
    amber: "from-accent-amber/20 to-accent-amber/5 text-accent-amber",
    rose: "from-accent-rose/20 to-accent-rose/5 text-accent-rose",
    emerald: "from-accent-emerald/20 to-accent-emerald/5 text-accent-emerald",
  };

  return (
    <div className="glass-card animate-fade-in-up relative overflow-hidden p-5">
      <div className={`absolute -right-6 -top-6 h-24 w-24 rounded-full bg-gradient-to-br ${accents[accent]} blur-2xl`} />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-base-400">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-base-50">{value}</p>
          {trend && <p className="mt-1.5 text-xs text-base-400">{trend}</p>}
        </div>
        {Icon && (
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${accents[accent]} border border-line-strong`}>
            <Icon size={18} />
          </div>
        )}
      </div>
    </div>
  );
}
