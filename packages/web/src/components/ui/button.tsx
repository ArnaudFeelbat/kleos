import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Kleos: macOS-density sizes (32/28/24 px), brand-filled primary with an inner top
// highlight, raised outline buttons, and a slight press-down on every variant.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium whitespace-nowrap select-none outline-none transition-[color,background-color,border-color,box-shadow,transform] duration-150 active:translate-y-px focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(0_0_0/0.18),0_0_0_1px_rgb(0_0_0/0.06)] hover:bg-primary/92 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_2px_rgb(0_0_0/0.5)]",
        destructive:
          "bg-destructive text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(0_0_0/0.18)] hover:bg-destructive/92 focus-visible:ring-destructive/25 dark:bg-destructive/85",
        outline:
          "bg-card text-foreground shadow-[0_0_0_1px_var(--edge),0_1px_2px_rgb(15_15_30/0.06)] hover:bg-accent dark:bg-white/[0.04] dark:shadow-[0_0_0_1px_var(--edge),inset_0_1px_0_var(--highlight)] dark:hover:bg-white/[0.07]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/75 dark:hover:bg-secondary/85",
        ghost:
          "text-foreground/80 hover:bg-accent hover:text-foreground dark:hover:bg-white/[0.06]",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 rounded-[5px] px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 rounded-[5px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
