function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value) {
  return String(value ?? "");
}

function compareNullableDescending(a, b) {
  const aFinite = finite(a);
  const bFinite = finite(b);
  if (!aFinite && !bFinite) return 0;
  if (!aFinite) return 1;
  if (!bFinite) return -1;
  return b - a;
}

function compareNullableAscending(a, b) {
  const aFinite = finite(a);
  const bFinite = finite(b);
  if (!aFinite && !bFinite) return 0;
  if (!aFinite) return 1;
  if (!bFinite) return -1;
  return a - b;
}

export function compareRankingRows(a, b, sortKey = "expectedReturn") {
  let result = 0;
  if (sortKey === "name") result = text(a.name).localeCompare(text(b.name), "ko");
  else if (sortKey === "rank") {
    const aRank = finite(a.rank) ? a.rank : Number.POSITIVE_INFINITY;
    const bRank = finite(b.rank) ? b.rank : Number.POSITIVE_INFINITY;
    result = aRank - bRank;
  } else if (sortKey === "error") {
    const aError = finite(a.error) ? Math.abs(a.error) : null;
    const bError = finite(b.error) ? Math.abs(b.error) : null;
    result = compareNullableAscending(aError, bError);
  } else if (sortKey === "expectedReturn") {
    // Unrounded value when present, matching the stored rank order.
    result = compareNullableDescending(finite(a.expectedReturnRaw) ? a.expectedReturnRaw : a.expectedReturn, finite(b.expectedReturnRaw) ? b.expectedReturnRaw : b.expectedReturn);
  } else {
    result = compareNullableDescending(a[sortKey], b[sortKey]);
  }
  if (result !== 0) return result;
  return text(a.symbol).localeCompare(text(b.symbol), "en") || text(a.name).localeCompare(text(b.name), "ko");
}

export function sortRankingRows(rows, sortKey = "expectedReturn") {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compareRankingRows(a.row, b.row, sortKey) || a.index - b.index)
    .map(({ row }) => row);
}
