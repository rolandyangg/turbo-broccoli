export function groupImprovementBacklog<T extends { status: string }>(items: T[]) {
  return {
    openCount: items.filter((item) => item.status === 'open').length,
    backlog: items.filter((item) => item.status !== 'merged' && item.status !== 'closed'),
    archive: items.filter((item) => item.status === 'merged' || item.status === 'closed'),
  };
}
