"use client"

import * as React from "react"
import { toast } from "sonner"

import {
  commitGate,
  getTrips,
  type GateDirection,
  type TripDay,
} from "@/lib/api"
import { clock as time, todayIso } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { GateCapture } from "@/components/common/gate-capture"

export function FleetWorkspace() {
  const [direction, setDirection] = React.useState<GateDirection>(() =>
    new Date().getHours() < 14 ? "checkout" : "checkin"
  )
  const [day, setDay] = React.useState(() => todayIso())
  const [log, setLog] = React.useState<TripDay | null>(null)

  const refreshLog = React.useCallback(async (date: string) => {
    try {
      setLog(await getTrips(date))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load hub log")
    }
  }, [])

  React.useEffect(() => {
    let active = true
    getTrips(day)
      .then((data) => active && setLog(data))
      .catch(
        (err) =>
          active &&
          toast.error(
            err instanceof Error ? err.message : "Could not load hub log"
          )
      )
    return () => {
      active = false
    }
  }, [day])

  async function commit(entry: Parameters<typeof commitGate>[1]) {
    const { trip } = await commitGate(direction, entry)
    toast.success(
      direction === "checkout"
        ? `${trip.plate_display} checked out at ${time(trip.checkout_at)}`
        : `${trip.plate_display} checked in — ${trip.distance_km} km`
    )
    if (day !== todayIso()) setDay(todayIso())
    else void refreshLog(day)
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <GateCapture
        direction={direction}
        onCommit={commit}
        header={
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["checkout", "Check-out", "Leaving hub"],
                ["checkin", "Check-in", "Returning"],
              ] as const
            ).map(([value, label, sub]) => (
              <Button
                key={value}
                type="button"
                variant={direction === value ? "secondary" : "outline"}
                className="h-auto flex-col gap-0 py-2"
                onClick={() => setDirection(value)}
              >
                <span>{label}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {sub}
                </span>
              </Button>
            ))}
          </div>
        }
      />

      <Card className="h-fit">
        <CardHeader className="grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <CardTitle>Gate log</CardTitle>
            <CardDescription>
              Every movement through the gate: fleet runs and customer pickups.
            </CardDescription>
          </div>
          <Input
            type="date"
            value={day}
            max={todayIso()}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="w-40"
          />
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["Still out", log?.summary.out],
                ["Returned", log?.summary.returned],
                [
                  "Distance",
                  log
                    ? `${log.summary.distance_km.toLocaleString()} km`
                    : undefined,
                ],
                ["Flagged", log?.summary.flagged],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-xl bg-muted/40 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold tabular-nums">
                  {value ?? "—"}
                </p>
              </div>
            ))}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>Out</TableHead>
                <TableHead>In</TableHead>
                <TableHead className="text-right">km</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log?.trips.length ? (
                log.trips.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-mono font-medium">
                        {t.plate_display}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {t.vin ?? "no VIN"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{time(t.checkout_at)}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {t.checkout_odo.toLocaleString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{time(t.checkin_at)}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {t.checkin_odo?.toLocaleString() ?? ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.distance_km?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge
                          variant={t.status === "out" ? "outline" : "secondary"}
                        >
                          {t.status === "out" ? "Out" : "Returned"}
                        </Badge>
                        {t.purpose === "pickup" ? (
                          <Badge variant="outline">customer pickup</Badge>
                        ) : null}
                        {t.flags.length ? (
                          <Badge
                            variant="destructive"
                            title={t.flags.map((x) => x.message).join("\n")}
                          >
                            {t.flags.length} flag{t.flags.length > 1 ? "s" : ""}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    No movements on this day.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
