'use client';

import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

interface MetricChartProps {
  data: { timestamp: number; value: number }[];
  color: string;
  title: string;
  unit?: string;
}

export function MetricChart({ data, color, title, unit = '' }: MetricChartProps) {
  if (data.length < 2) {
    return (
      <div className="h-[120px] flex items-center justify-center text-xs text-muted-foreground">
        Collecting data for {title}...
      </div>
    );
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-[120px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`gradient-${title}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="timestamp"
            tickFormatter={formatTime}
            tick={{ fill: '#666', fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fill: '#666', fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            width={35}
            tickFormatter={(v) => `${v}${unit}`}
          />
          <Tooltip
            labelFormatter={formatTime}
            formatter={(value: number) => [`${value.toFixed(1)}${unit}`, title]}
            contentStyle={{
              backgroundColor: '#111',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              fontSize: 11,
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            fill={`url(#gradient-${title})`}
            strokeWidth={1.5}
            dot={false}
            animationDuration={300}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
