import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Mono hairline chips — no color fills; the red appears as text only
// (destructive) per the accent rule.
const badgeVariants = cva(
  "inline-flex items-center border px-2 py-0.5 font-mono text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-rule2 bg-paper2 text-ink",
        secondary: "border-rule bg-paper2 text-graphite",
        outline: "border-rule2 text-ink",
        destructive: "border-red/50 text-red",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
