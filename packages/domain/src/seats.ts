export const ACADEMY_SEAT_LIMIT = 3;

export type SeatOccupantKind = "member" | "pending_invite";

export function remainingAcademySeats(occupied: number, limit = ACADEMY_SEAT_LIMIT) {
  return Math.max(0, limit - occupied);
}

export function canInviteAcademySeat(occupied: number, limit = ACADEMY_SEAT_LIMIT) {
  return remainingAcademySeats(occupied, limit) > 0;
}

export function assertCanInviteAcademySeat(occupied: number, limit = ACADEMY_SEAT_LIMIT) {
  if (!canInviteAcademySeat(occupied, limit)) {
    throw new Error("This academy account already has three seats.");
  }
}
