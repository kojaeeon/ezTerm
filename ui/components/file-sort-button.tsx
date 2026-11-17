import type { FileSort, FileSortColumn } from '@/lib/file-sort';

export function FileSortButton({ column, sort, onSort, children }: {
  column: FileSortColumn;
  sort: FileSort;
  onSort: (column: FileSortColumn) => void;
  children: React.ReactNode;
}) {
  const active = sort.column === column;
  return (
    <button type="button" className="w-full whitespace-nowrap text-inherit [font:inherit] [text-transform:inherit] [letter-spacing:inherit] text-left hover:text-fg focus-ring"
      onClick={() => onSort(column)} title={`${children}: ${active && sort.direction === 'asc' ? '내림차순' : '오름차순'} 정렬`}>
      {children}<span aria-hidden="true" className="ml-1">{active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span>
    </button>
  );
}
