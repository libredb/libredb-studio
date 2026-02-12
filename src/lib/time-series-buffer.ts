export interface TimeSeriesPoint<T> {
  timestamp: number;
  data: T;
}

export class TimeSeriesBuffer<T> {
  private buffer: TimeSeriesPoint<T>[];
  private head: number = 0;
  private count: number = 0;
  private readonly maxSize: number;

  constructor(maxSize: number = 120) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  push(data: T): void {
    const point: TimeSeriesPoint<T> = {
      timestamp: Date.now(),
      data,
    };
    this.buffer[this.head] = point;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) {
      this.count++;
    }
  }

  getAll(): TimeSeriesPoint<T>[] {
    if (this.count === 0) return [];
    const result: TimeSeriesPoint<T>[] = [];
    const start = this.count < this.maxSize ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.maxSize;
      result.push(this.buffer[idx]);
    }
    return result;
  }

  getRange(from: number, to: number): TimeSeriesPoint<T>[] {
    return this.getAll().filter(p => p.timestamp >= from && p.timestamp <= to);
  }

  getLast(n: number): TimeSeriesPoint<T>[] {
    const all = this.getAll();
    return all.slice(Math.max(0, all.length - n));
  }

  clear(): void {
    this.buffer = new Array(this.maxSize);
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}
