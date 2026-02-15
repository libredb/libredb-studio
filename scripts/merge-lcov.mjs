#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseLcov(content) {
  const records = [];
  const rawRecords = content.split("end_of_record");

  for (const raw of rawRecords) {
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      continue;
    }

    const record = {
      sf: "",
      functions: new Map(),
      functionHits: new Map(),
      lines: new Map(),
      branches: new Map(),
    };

    for (const line of lines) {
      if (line.startsWith("SF:")) {
        record.sf = line.slice(3);
        continue;
      }

      if (line.startsWith("FN:")) {
        const payload = line.slice(3);
        const commaIndex = payload.indexOf(",");
        if (commaIndex >= 0) {
          const lineNumber = Number(payload.slice(0, commaIndex));
          const functionName = payload.slice(commaIndex + 1);
          record.functions.set(functionName, Number.isFinite(lineNumber) ? lineNumber : 0);
        }
        continue;
      }

      if (line.startsWith("FNDA:")) {
        const payload = line.slice(5);
        const commaIndex = payload.indexOf(",");
        if (commaIndex >= 0) {
          const hits = Number(payload.slice(0, commaIndex)) || 0;
          const functionName = payload.slice(commaIndex + 1);
          record.functionHits.set(functionName, hits);
        }
        continue;
      }

      if (line.startsWith("DA:")) {
        const payload = line.slice(3);
        const commaIndex = payload.indexOf(",");
        if (commaIndex >= 0) {
          const lineNumber = Number(payload.slice(0, commaIndex));
          const hits = Number(payload.slice(commaIndex + 1)) || 0;
          if (Number.isFinite(lineNumber)) {
            record.lines.set(lineNumber, hits);
          }
        }
        continue;
      }

      if (line.startsWith("BRDA:")) {
        const payload = line.slice(5);
        const [lineNoRaw, blockNoRaw, branchNoRaw, takenRaw] = payload.split(",");
        const lineNo = Number(lineNoRaw);
        const blockNo = Number(blockNoRaw);
        const branchNo = Number(branchNoRaw);
        const key = `${lineNo},${blockNo},${branchNo}`;
        const taken = takenRaw === "-" ? -1 : Number(takenRaw) || 0;
        if (Number.isFinite(lineNo) && Number.isFinite(blockNo) && Number.isFinite(branchNo)) {
          record.branches.set(key, taken);
        }
      }
    }

    if (record.sf) {
      records.push(record);
    }
  }

  return records;
}

function mergeRecords(inputRecords) {
  const byFile = new Map();

  for (const record of inputRecords) {
    const existing = byFile.get(record.sf) || {
      sf: record.sf,
      functions: new Map(),
      functionHits: new Map(),
      lines: new Map(),
      branches: new Map(),
    };

    for (const [fnName, fnLine] of record.functions.entries()) {
      if (!existing.functions.has(fnName)) {
        existing.functions.set(fnName, fnLine);
      }
    }

    for (const [fnName, hits] of record.functionHits.entries()) {
      const prevHits = existing.functionHits.get(fnName) || 0;
      existing.functionHits.set(fnName, Math.max(prevHits, hits));
    }

    for (const [lineNo, hits] of record.lines.entries()) {
      const prevHits = existing.lines.get(lineNo) || 0;
      existing.lines.set(lineNo, Math.max(prevHits, hits));
    }

    for (const [key, taken] of record.branches.entries()) {
      const prevTaken = existing.branches.has(key) ? existing.branches.get(key) : -1;
      if (prevTaken === -1 && taken !== -1) {
        existing.branches.set(key, taken);
      } else if (prevTaken !== -1 && taken === -1) {
        existing.branches.set(key, prevTaken);
      } else {
        existing.branches.set(key, Math.max(prevTaken, taken));
      }
    }

    byFile.set(record.sf, existing);
  }

  return [...byFile.values()].sort((a, b) => a.sf.localeCompare(b.sf));
}

function serializeRecords(records) {
  const chunks = [];

  for (const record of records) {
    const lines = [];
    lines.push(`SF:${record.sf}`);

    const sortedFunctions = [...record.functions.entries()].sort((a, b) => a[1] - b[1]);
    for (const [fnName, fnLine] of sortedFunctions) {
      lines.push(`FN:${fnLine},${fnName}`);
    }

    for (const [fnName] of sortedFunctions) {
      const hits = record.functionHits.get(fnName) || 0;
      lines.push(`FNDA:${hits},${fnName}`);
    }

    const fnf = sortedFunctions.length;
    const fnh = sortedFunctions.reduce((acc, [fnName]) => acc + ((record.functionHits.get(fnName) || 0) > 0 ? 1 : 0), 0);
    lines.push(`FNF:${fnf}`);
    lines.push(`FNH:${fnh}`);

    const sortedLineEntries = [...record.lines.entries()].sort((a, b) => a[0] - b[0]);
    for (const [lineNo, hits] of sortedLineEntries) {
      lines.push(`DA:${lineNo},${hits}`);
    }

    const lf = sortedLineEntries.length;
    const lh = sortedLineEntries.reduce((acc, [, hits]) => acc + (hits > 0 ? 1 : 0), 0);
    lines.push(`LF:${lf}`);
    lines.push(`LH:${lh}`);

    if (record.branches.size > 0) {
      const sortedBranchEntries = [...record.branches.entries()].sort((a, b) => {
        const [aLine, aBlock, aBranch] = a[0].split(",").map(Number);
        const [bLine, bBlock, bBranch] = b[0].split(",").map(Number);
        if (aLine !== bLine) return aLine - bLine;
        if (aBlock !== bBlock) return aBlock - bBlock;
        return aBranch - bBranch;
      });

      for (const [key, taken] of sortedBranchEntries) {
        const takenValue = taken < 0 ? "-" : String(taken);
        lines.push(`BRDA:${key},${takenValue}`);
      }

      const brf = sortedBranchEntries.length;
      const brh = sortedBranchEntries.reduce((acc, [, taken]) => acc + (taken > 0 ? 1 : 0), 0);
      lines.push(`BRF:${brf}`);
      lines.push(`BRH:${brh}`);
    }

    lines.push("end_of_record");
    chunks.push(lines.join("\n"));
  }

  return chunks.join("\n");
}

function main() {
  const [, , ...args] = process.argv;
  if (args.length < 3) {
    console.error("Usage: node scripts/merge-lcov.mjs <input1> <input2> [moreInputs...] <output>");
    process.exit(1);
  }

  const outputPath = args[args.length - 1];
  const inputPaths = args.slice(0, -1);
  const allRecords = [];

  for (const inputPath of inputPaths) {
    const content = fs.readFileSync(inputPath, "utf8");
    allRecords.push(...parseLcov(content));
  }

  const merged = mergeRecords(allRecords);
  const serialized = serializeRecords(merged);

  ensureParentDir(outputPath);
  fs.writeFileSync(outputPath, serialized ? `${serialized}\n` : "", "utf8");
  console.log(`Merged ${inputPaths.length} LCOV file(s) into ${outputPath}`);
  console.log(`Records: ${merged.length}`);
}

main();
