import type React from "react";
import { useEffect, useRef, useState } from "react";

/**
 * Lets a Radix Popover open on mouse hover while keeping click/tap behaviour for
 * touch and keyboard users. Clicking a hover-opened popover pins it open.
 */
export const useHoverPopover = ({
	openDelay = 120,
	closeDelay = 200,
}: {
	openDelay?: number;
	closeDelay?: number;
} = {}) => {
	const [open, setOpen] = useState(false);
	const openedByHover = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const schedule = (next: boolean, delay: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			openedByHover.current = next;
			setOpen(next);
		}, delay);
	};

	const onPointerEnter = (event: React.PointerEvent) => {
		if (event.pointerType !== "mouse") return;
		if (open) clearTimeout(timer.current);
		else schedule(true, openDelay);
	};

	const onPointerLeave = (event: React.PointerEvent) => {
		if (event.pointerType !== "mouse") return;
		if (!open) clearTimeout(timer.current);
		else if (openedByHover.current) schedule(false, closeDelay);
	};

	const setOpenNow = (next: boolean) => {
		clearTimeout(timer.current);
		openedByHover.current = false;
		setOpen(next);
	};

	return {
		open,
		setOpen: setOpenNow,
		triggerProps: {
			onPointerEnter,
			onPointerLeave,
			onClick: (event: React.MouseEvent) => {
				if (open && openedByHover.current) {
					// Radix would toggle it closed; a click on a hover-opened popover pins it instead.
					event.preventDefault();
					openedByHover.current = false;
					clearTimeout(timer.current);
				}
			},
		},
		contentProps: {
			onPointerEnter,
			onPointerLeave,
			onOpenAutoFocus: (event: Event) => {
				if (openedByHover.current) event.preventDefault();
			},
		},
	};
};
