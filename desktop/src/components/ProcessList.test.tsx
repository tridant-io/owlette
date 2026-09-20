import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessList } from '@/components/ProcessList'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProcessEntry } from '@/lib/owletteConfig'
import type { AppStates } from '@/lib/processStatus'
import { isRowDragging } from '@/lib/rowDrag'

const processes: ProcessEntry[] = [
  { id: 'a', name: 'touch', exe_path: 'C:/Program Files/Derivative/bin/TouchDesigner.exe' },
  { id: 'b', name: 'node.js', exe_path: 'C:/tools/node.exe' },
  { id: 'c', name: '' },
]

const states: AppStates = {
  '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
  '200': { id: 'b', status: 'LAUNCH_FAILED', timestamp: 20 },
}

function setup(
  selectedId: string | null = null,
  entries = processes,
  options: { dragOver?: boolean; collapsed?: boolean } = {},
) {
  const handlers = {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onAction: vi.fn(),
    onReorder: vi.fn(),
    onCollapsedChange: vi.fn(),
  }

  render(
    <TooltipProvider>
      <ProcessList
        processes={entries}
        states={states}
        selectedId={selectedId}
        dragOver={options.dragOver}
        collapsed={options.collapsed}
        {...handlers}
      />
    </TooltipProvider>,
  )

  return handlers
}

function rows() {
  return screen.getAllByTestId('process-row')
}

/** jsdom lays nothing out and has no pointer capture — fake 40px stacked rows. */
const ROW_HEIGHT = 40
function stubGeometry() {
  rows().forEach((row, index) => {
    row.setPointerCapture = () => {}
    row.releasePointerCapture = () => {}
    row.getBoundingClientRect = () =>
      ({
        top: index * ROW_HEIGHT,
        bottom: (index + 1) * ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 240,
        width: 240,
        x: 0,
        y: index * ROW_HEIGHT,
        toJSON: () => ({}),
      }) as DOMRect
  })
}

/**
 * jsdom has no `PointerEvent`, so testing-library builds a bare `Event` with
 * undefined `button`/`clientY`. `MouseEvent` carries both; pointerId is pinned on.
 */
function pointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  { clientY, button = 0, pointerId = 1 }: { clientY: number; button?: number; pointerId?: number },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button, clientY })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  fireEvent(element, event)
}

/** Press on `from`, travel to `clientY`, release. */
function dragRow(from: number, clientY: number) {
  const row = rows()[from]
  stubGeometry()
  pointer(row, 'pointerdown', { clientY: from * ROW_HEIGHT + 20 })
  pointer(row, 'pointermove', { clientY })
  pointer(row, 'pointerup', { clientY })
}

afterEach(() => {
  // A test that leaves the flag set would lie to the next one.
  expect(isRowDragging()).toBe(false)
})

describe('process list', () => {
  it('joins each entry to the status the service published for it', () => {
    setup()

    expect(rows().map((row) => row.dataset.status)).toEqual([
      'RUNNING',
      'LAUNCH_FAILED',
      // Never launched — no entry in the service's table.
      'INACTIVE',
    ])
  })

  it('gives a nameless entry something to click on', () => {
    setup()

    expect(rows()[2].textContent).toBe('untitled process')
  })

  it('marks the selected entry', () => {
    setup('b')

    expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual([
      'false',
      'true',
      'false',
    ])
  })

  it('selects on click', () => {
    const { onSelect } = setup()

    fireEvent.click(rows()[1])

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('selects the entry that was right-clicked before opening its menu', () => {
    const { onSelect } = setup()

    fireEvent.contextMenu(rows()[1])

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('shows the drop-a-file directions when there is nothing to list', () => {
    setup(null, [])

    expect(screen.queryAllByTestId('process-row')).toHaveLength(0)
    expect(screen.getByTestId('process-list-empty').textContent).toMatch(/no processes yet/)
    expect(screen.getByTestId('process-list-empty').textContent).toMatch(/drag an app/)
  })

  it('lights up the empty state while a file is over the window', () => {
    setup(null, [], { dragOver: true })

    expect(screen.getByTestId('process-list-empty').dataset.dragOver).toBe('true')
  })

  it('keeps whispering the drop gesture once there are rows to list', () => {
    setup()

    const hint = screen.getByTestId('process-list-drop-hint')
    expect(hint.textContent).toMatch(/drop an app or script here to add it/)
    // Inert: a drop target, reorder drag and context menu share this column.
    expect(hint.className).toContain('pointer-events-none')
    expect(hint.className).toContain('text-sm')
    // Outside the `ul`, so it is not part of the reorder surface.
    expect(hint.closest('ul')).toBeNull()
    const region = hint.parentElement
    expect(region?.className).toContain('flex-1')
    expect(region?.className).toContain('items-center')
    expect(region?.className).toContain('justify-center')
    expect(region?.previousElementSibling?.tagName).toBe('UL')
    expect(region?.parentElement?.className).toContain('min-h-full')
  })

  it('leaves the hint to the empty state when there is nothing to list', () => {
    setup(null, [])

    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()
  })
})

describe('process icons', () => {
  it('draws one glyph per entry, in the same box', () => {
    setup()

    const icons = screen.getAllByTestId('process-icon')
    expect(icons).toHaveLength(3)
    expect(icons[0].getAttribute('class')).toContain('size-4')
  })

  it('puts the icon between the status dot and the name', () => {
    setup()
    const icon = screen.getAllByTestId('process-icon')[0]

    const row = icon.closest('[data-testid="process-row"]')
    const children = [...(row?.children ?? [])]
    expect(children.indexOf(icon)).toBe(2) // grip, dot, icon, name
    expect(children[3]?.textContent).toBe('touch')
  })
})

describe('the collapsed rail', () => {
  it('keeps the add button and drops the heading', () => {
    setup(null, processes, { collapsed: true })

    expect(screen.getByTestId('process-list').dataset.collapsed).toBe('true')
    expect(screen.getByRole('button', { name: 'add process' })).toBeTruthy()
    expect(screen.queryByText('processes')).toBeNull()
  })

  it('shows one icon per entry, with the status dot in its corner', () => {
    setup(null, processes, { collapsed: true })

    expect(screen.getAllByTestId('process-icon')).toHaveLength(3)
    const dots = screen.getAllByTestId('rail-status-dot')
    expect(dots).toHaveLength(3)
    // Same statuses as the expanded list draws, in the same colours.
    expect(dots[0].className).toContain('bg-green-500')
    expect(dots[1].className).toContain('bg-red-500')
    expect(dots[0].className).toContain('absolute')
  })

  it('names each row, since the rail has nowhere to print one', () => {
    setup(null, processes, { collapsed: true })

    expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual([
      'touch',
      'node.js',
      'untitled process',
    ])
  })

  it('still selects, reorders and opens the context menu', () => {
    const { onSelect, onReorder } = setup(null, processes, { collapsed: true })

    fireEvent.click(rows()[1])
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')

    dragRow(0, 110)
    expect(onReorder).toHaveBeenCalledExactlyOnceWith('a', 2)

    fireEvent.contextMenu(rows()[2])
    expect(screen.getByRole('menuitem', { name: 'delete' })).toBeTruthy()
  })

  it('offers restart and kill only while something is running', () => {
    setup(null, processes, { collapsed: true })

    // 'a' has a RUNNING generation; 'c' has never launched.
    fireEvent.contextMenu(rows()[0])
    expect(screen.getByRole('menuitem', { name: 'restart process' }).ariaDisabled).not.toBe('true')
    expect(screen.getByRole('menuitem', { name: 'kill process' }).ariaDisabled).not.toBe('true')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    fireEvent.contextMenu(rows()[2])
    expect(screen.getByRole('menuitem', { name: 'restart process' }).ariaDisabled).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'kill process' }).ariaDisabled).toBe('true')
  })

  it('drops the copy that has nowhere to go at 48 px', () => {
    setup(null, processes, { collapsed: true })

    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()
  })

  it('says nothing at all when an empty list is collapsed', () => {
    setup(null, [], { collapsed: true })

    expect(screen.queryByTestId('process-list-empty')).toBeNull()
    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()
    expect(screen.getByRole('button', { name: 'add process' })).toBeTruthy()
  })

  it('offers a way back out, pinned below the icons', () => {
    const { onCollapsedChange } = setup(null, processes, { collapsed: true })

    const expand = screen.getByTestId('expand-sidebar')
    expect(expand.getAttribute('aria-label')).toBe('expand the process list')
    fireEvent.click(expand)

    expect(onCollapsedChange).toHaveBeenCalledExactlyOnceWith(false)
    // The rail has no collapse control — it is already collapsed.
    expect(screen.queryByTestId('collapse-sidebar')).toBeNull()
  })
})

describe('the collapse toggle', () => {
  /**
   * The toggle's row. Found through the button because `TooltipTrigger asChild`
   * renders no wrapper: button → opaque ground → this row.
   */
  function footer() {
    return ground().parentElement as HTMLElement
  }

  /** The opaque patch the button stands on, which is the button's parent. */
  function ground() {
    const toggle =
      screen.queryByTestId('collapse-sidebar') ?? screen.getByTestId('expand-sidebar')
    return toggle.parentElement as HTMLElement
  }

  it('sits at the bottom of the column, right-aligned while expanded', () => {
    const { onCollapsedChange } = setup()

    const collapse = screen.getByTestId('collapse-sidebar')
    expect(collapse.getAttribute('aria-label')).toBe('collapse the process list')
    // Below the list, not in the header beside `+`.
    expect(footer().contains(collapse)).toBe(true)
    expect(footer().className).toContain('justify-end')
    // Inside the scroller, stuck to its floor. A row BELOW the scroller cut the
    // scrollbar track short of the sidebar's edge and read as a render fault.
    expect(footer().className).toContain('sticky')
    expect(footer().nextElementSibling).toBeNull()
    // Veils rather than cuts: the ground fades in from transparent so a row
    // dissolves into it. The button keeps its own solid patch to stay legible.
    expect(footer().className).toContain('linear-gradient(to_bottom,transparent,var(--background)_60%)')
    expect(ground().className).toContain('bg-background')
    expect(ground().className).toContain('p-1')
    const column = footer().parentElement
    expect(column?.className).toContain('min-h-full')
    expect(column?.parentElement?.className).toContain('overflow-y-auto')
    expect(screen.getByRole('button', { name: 'add process' }).closest('header')).toBeTruthy()

    fireEvent.click(collapse)
    expect(onCollapsedChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(screen.queryByTestId('expand-sidebar')).toBeNull()
  })

  it('sits in the same corner of the rail, which at 48 px is the middle', () => {
    setup(null, processes, { collapsed: true })

    expect(footer().contains(screen.getByTestId('expand-sidebar'))).toBe(true)
    expect(footer().className).toContain('justify-center')
  })

  it('is left out entirely when the caller does not offer collapsing', () => {
    render(
      <TooltipProvider>
        <ProcessList
          processes={processes}
          states={states}
          selectedId={null}
          onSelect={vi.fn()}
          onAdd={vi.fn()}
          onAction={vi.fn()}
          onReorder={vi.fn()}
        />
      </TooltipProvider>,
    )

    expect(screen.queryByTestId('collapse-sidebar')).toBeNull()
    expect(screen.queryByTestId('expand-sidebar')).toBeNull()
  })
})

describe('the room the drop hint needs', () => {
  /** Every box a ResizeObserver was pointed at, and the way to make it fire. */
  let watching: { element: Element; fire: () => void }[] = []

  beforeEach(() => {
    watching = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        callback: () => void
        constructor(callback: () => void) {
          this.callback = callback
        }
        observe(element: Element) {
          watching.push({ element, fire: () => this.callback() })
        }
        unobserve() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** jsdom lays nothing out, so the box is told how tall it came out. */
  function measure(height: number) {
    const room = screen.getByTestId('process-list-drop-room')
    Object.defineProperty(room, 'clientHeight', { value: height, configurable: true })
    act(() => {
      watching.filter((watch) => watch.element === room).forEach((watch) => watch.fire())
    })
  }

  it('withholds the sentence once the rows leave it nowhere to sit', () => {
    setup()

    measure(400)
    expect(screen.getByTestId('process-list-drop-hint')).toBeTruthy()

    measure(140)
    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()
    // The box stays behind: it is what the next measurement is taken from.
    expect(screen.getByTestId('process-list-drop-room')).toBeTruthy()
  })

  it('draws the line where the sentence stops sitting comfortably', () => {
    setup()

    // 160px is the ~70px stack plus 45px of air on each side of it.
    measure(159)
    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()

    measure(160)
    expect(screen.getByTestId('process-list-drop-hint')).toBeTruthy()
  })

  it('keeps the hint out of the scrollable extent entirely', () => {
    setup()

    // `flex-1 min-h-0`: the box is exactly the room the rows leave, and it
    // collapses to nothing once they take it all — so the scrollbar measures
    // the list of processes and nothing else.
    const room = screen.getByTestId('process-list-drop-room')
    expect(room.className).toContain('flex-1')
    expect(room.className).toContain('min-h-0')
  })
})

describe('drag to reorder', () => {
  it('commits one move when a row is dropped further down', () => {
    const { onReorder } = setup()

    // Past the last row's midpoint: the first row becomes the last.
    dragRow(0, 110)

    expect(onReorder).toHaveBeenCalledExactlyOnceWith('a', 2)
  })

  it('commits one move when a row is dropped further up', () => {
    const { onReorder } = setup()

    dragRow(2, 10)

    expect(onReorder).toHaveBeenCalledExactlyOnceWith('c', 0)
  })

  it('writes nothing when the row is dropped where it already was', () => {
    const { onReorder } = setup()

    dragRow(1, 55)

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('writes nothing for a press that never became a drag', () => {
    const { onReorder, onSelect } = setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 22 })
    pointer(row, 'pointerup', { clientY: 22 })
    fireEvent.click(row)

    expect(onReorder).not.toHaveBeenCalled()
    // …and the press still selects, which is what a click on a row means.
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('shows where the row would land, and lifts the one being dragged', () => {
    setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 110 })

    expect(screen.getByTestId('drop-indicator')).toBeTruthy()
    expect(rows()[0].dataset.dragging).toBe('true')
    // The file-drop overlay a later task adds must be able to tell this apart
    // from an OS drag.
    expect(isRowDragging()).toBe(true)
    expect(document.body.dataset.rowDragging).toBe('true')

    pointer(row, 'pointerup', { clientY: 110 })
    expect(screen.queryByTestId('drop-indicator')).toBeNull()
  })

  it('abandons the drag on escape', () => {
    const { onReorder } = setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 110 })
    fireEvent.keyDown(window, { key: 'Escape' })
    pointer(row, 'pointerup', { clientY: 110 })

    expect(onReorder).not.toHaveBeenCalled()
    expect(screen.queryByTestId('drop-indicator')).toBeNull()
  })

  it('ignores a right-button press, which belongs to the context menu', () => {
    const { onReorder } = setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20, button: 2 })
    pointer(row, 'pointermove', { clientY: 110 })
    pointer(row, 'pointerup', { clientY: 110 })

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('has nothing to drag in a one-row list', () => {
    const { onReorder } = setup(null, [processes[0]])
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 110 })
    pointer(row, 'pointerup', { clientY: 110 })

    expect(onReorder).not.toHaveBeenCalled()
  })
})
