/**
 * Hand-rolled Prometheus text exposition. No prom-client: the service has
 * four series and a fixed histogram, and the family definitions below are
 * the single source of truth for label order, buckets, and render order.
 */

const HISTOGRAM_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];

interface CounterDef {
  kind: "counter";
  name: string;
  help: string;
  labels: string[];
}

interface HistogramDef {
  kind: "histogram";
  name: string;
  help: string;
  labels: string[];
  buckets: number[];
}

const FAMILIES: Array<CounterDef | HistogramDef> = [
  {
    kind: "counter",
    name: "zenigata_reviews_total",
    help: "Reviews processed, by repository and outcome status.",
    labels: ["repo", "status"],
  },
  {
    kind: "counter",
    name: "zenigata_replies_total",
    help: "Replies processed, by repository.",
    labels: ["repo"],
  },
  {
    kind: "counter",
    name: "zenigata_memory_observations_total",
    help: "Observations written through the memory gateway, by source.",
    labels: ["source"],
  },
  {
    kind: "histogram",
    name: "zenigata_review_phase_seconds",
    help: "Duration of review pipeline phases in seconds.",
    labels: ["phase"],
    buckets: HISTOGRAM_BUCKETS,
  },
];

const familyByName = new Map(FAMILIES.map((f) => [f.name, f]));

/** Label values in the family's declared order; key for the series. */
export type LabelSet = Record<string, string>;

const seriesKey = (name: string, def: { labels: string[] }, labels: LabelSet) =>
  `${name}|${def.labels.map((l) => labels[l] ?? "").join("|")}`;

const labelBlock = (def: { labels: string[] }, labels: LabelSet) =>
  def.labels.map((l) => `${l}=${JSON.stringify(labels[l] ?? "")}`).join(",");

interface CounterSeries {
  def: CounterDef;
  labels: LabelSet;
  value: number;
}

interface HistogramSeries {
  def: HistogramDef;
  labels: LabelSet;
  bucketCounts: number[];
  sum: number;
  count: number;
}

export class Metrics {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();

  /** Increment a declared counter family. Unknown families throw. */
  inc(name: string, labels: LabelSet): void {
    const def = familyByName.get(name);
    if (!def || def.kind !== "counter") {
      throw new Error(`metrics: ${name} is not a declared counter`);
    }
    const key = seriesKey(name, def, labels);
    const series = this.counters.get(key) ?? {
      def,
      labels: this.canonical(def, labels),
      value: 0,
    };
    series.value += 1;
    this.counters.set(key, series);
  }

  /** Observe one value (seconds) into a declared histogram family. */
  observe(name: string, labels: LabelSet, value: number): void {
    const def = familyByName.get(name);
    if (!def || def.kind !== "histogram") {
      throw new Error(`metrics: ${name} is not a declared histogram`);
    }
    const key = seriesKey(name, def, labels);
    const series = this.histograms.get(key) ?? {
      def,
      labels: this.canonical(def, labels),
      bucketCounts: def.buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    def.buckets.forEach((bound, i) => {
      if (value <= bound) {
        series.bucketCounts[i] += 1;
      }
    });
    series.sum += value;
    series.count += 1;
    this.histograms.set(key, series);
  }

  /** Fill missing label values so a series renders deterministically. */
  private canonical(def: { labels: string[] }, labels: LabelSet): LabelSet {
    const out: LabelSet = {};
    for (const label of def.labels) {
      out[label] = labels[label] ?? "";
    }
    return out;
  }

  /** Prometheus text exposition, families in declaration order, series
   * sorted deterministically by label values. */
  render(): string {
    const lines: string[] = [];
    const seriesSort = (
      a: { labels: LabelSet },
      b: { labels: LabelSet },
    ): number => {
      const ka = Object.values(a.labels).join("|");
      const kb = Object.values(b.labels).join("|");
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    };

    for (const def of FAMILIES) {
      lines.push(`# HELP ${def.name} ${def.help}`);
      lines.push(`# TYPE ${def.name} ${def.kind}`);
      if (def.kind === "counter") {
        const series = [...this.counters.values()]
          .filter((s) => s.def.name === def.name)
          .sort(seriesSort);
        for (const s of series) {
          const block = labelBlock(def, s.labels);
          lines.push(`${def.name}{${block}} ${s.value}`);
        }
      } else {
        const series = [...this.histograms.values()]
          .filter((s) => s.def.name === def.name)
          .sort(seriesSort);
        for (const s of series) {
          const block = labelBlock(def, s.labels);
          def.buckets.forEach((bound, i) => {
            lines.push(
              `${def.name}_bucket{${block},le="${bound}"} ${s.bucketCounts[i]}`,
            );
          });
          lines.push(`${def.name}_bucket{${block},le="+Inf"} ${s.count}`);
          lines.push(`${def.name}_sum{${block}} ${s.sum}`);
          lines.push(`${def.name}_count{${block}} ${s.count}`);
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }
}
