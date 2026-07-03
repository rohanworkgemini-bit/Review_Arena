import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Two button grammars from the reference:
//   default  = .cta  — ink fill, paper text, hover turns red
//   outline  = .btn  — paper fill, 1px ink border, hover fills red
// Both mono, square, no shadow. Keyboard focus comes from the global
// :focus-visible outline (2px red, offset) in index.css.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-mono text-[13px] font-medium tracking-[0.02em] transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border border-ink bg-ink text-paper hover:border-red hover:bg-red",
        outline: "border border-ink bg-paper text-ink hover:border-red hover:bg-red hover:text-paper",
        ghost: "text-graphite hover:bg-paper2 hover:text-ink",
        secondary: "border border-rule bg-paper2 text-ink hover:border-rule2",
        destructive: "border border-red bg-red text-paper hover:border-redink hover:bg-redink",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3 text-xs",
        lg: "h-12 px-6 text-sm",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = "Button";
