"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ImageOff,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Shield,
  Users,
  X,
} from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { toast } from "sonner";
import {
  getPeople,
  getPersonImages,
  type PersonItem,
  triggerFaceClustering,
  updatePersonName,
} from "@/lib/api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ─── Person Card Component ────────────────────────────────────────────────────

function PersonCard({
  person,
  onClick,
  onNameSaved,
}: {
  person: PersonItem;
  onClick: () => void;
  onNameSaved: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [nameInput, setNameInput] = useState(person.name ?? "");

  const submitName = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      toast.error("Name cannot be empty");
      return;
    }
    nameMutation.mutate(trimmed);
  };

  const nameMutation = useMutation({
    mutationFn: (name: string) => updatePersonName(person.id, name),
    onSuccess: () => {
      toast.success("Name saved!");
      setIsEditing(false);
      onNameSaved();
    },
    onError: () => {
      toast.error("Failed to save name");
    },
  });

  return (
    <article className="frost-panel card-hover rounded-3xl p-5">
      {/* Sample face thumbnails */}
      <button
        type="button"
        className="mb-4 grid w-full cursor-pointer grid-cols-2 gap-2 text-left"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter") onClick();
        }}
      >
        {person.sample_media_ids.length > 0 ? (
          person.sample_media_ids.slice(0, 4).map((mediaId) => (
            <div
              key={mediaId}
              className="relative aspect-square overflow-hidden rounded-2xl border border-[var(--frost)] bg-white/[0.025]"
            >
              <Image
                src={`${API_BASE_URL}/api/image/${mediaId}/thumbnail`}
                alt="Person photo"
                fill
                className="object-cover"
                sizes="(max-width: 768px) 25vw, 10vw"
                unoptimized
              />
            </div>
          ))
        ) : (
          <div className="col-span-2 flex aspect-square items-center justify-center rounded-2xl border border-[var(--frost)] bg-white/[0.025] text-[#5f6568]">
            <ImageOff className="h-8 w-8" />
          </div>
        )}
      </button>

      {/* Person name + edit */}
      <div className="mb-3 flex items-center gap-2">
        {isEditing ? (
          <div className="flex flex-1 items-center gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitName();
                if (e.key === "Escape") setIsEditing(false);
              }}
              placeholder="Enter a name..."
              className="flex-1 rounded-xl border border-[var(--frost)] bg-white/[0.03] px-3 py-1.5 text-sm text-[#f0f0f0] outline-none focus:border-[#3b9eff]"
            />
            <button
              type="button"
              onClick={submitName}
              disabled={nameMutation.isPending}
              className="icon-button"
              aria-label="Save name"
            >
              {nameMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="icon-button"
              aria-label="Cancel"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <>
            <p className="flex-1 text-base font-medium text-[#f0f0f0]">
              {person.name?.trim() ? (
                person.name
              ) : (
                <span className="text-[#5f6568]">Unknown person</span>
              )}
            </p>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="icon-button"
              aria-label="Edit name"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </>
        )}
      </div>

      {/* Face count + view button */}
      <div className="flex items-center justify-between">
        <span className="accent-badge status-default">
          {person.face_count} {person.face_count === 1 ? "photo" : "photos"}
        </span>
        <button
          type="button"
          onClick={onClick}
          className="frost-button px-3 py-1.5 text-xs font-medium"
        >
          View photos
        </button>
      </div>
    </article>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PeoplePage() {
  const queryClient = useQueryClient();
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);

  const {
    data: people,
    isLoading,
    error,
    isFetching,
  } = useQuery({
    queryKey: ["people"],
    queryFn: getPeople,
    refetchInterval: 15000,
  });

  const selectedPersonQuery = useQuery({
    queryKey: ["person-images", selectedPersonId],
    queryFn: () => getPersonImages(selectedPersonId as number),
    enabled: selectedPersonId !== null,
  });

  const clusterMutation = useMutation({
    mutationFn: triggerFaceClustering,
    onSuccess: () => {
      toast.success("Face clustering complete!");
      queryClient.invalidateQueries({ queryKey: ["people"] });
    },
    onError: () => {
      toast.error("Face clustering failed");
    },
  });

  return (
    <div className="page-shell">
      <div className="container-shell py-10 md:py-14">
        {/* Page header */}
        <div className="page-enter mb-10 flex flex-col gap-6 border-b border-[var(--frost)] pb-8 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <h1 className="section-heading mb-4 text-5xl font-medium md:text-6xl">
              People
            </h1>
            <p className="muted-copy text-sm leading-6">
              Photos grouped by person, detected and clustered entirely on your
              device.
            </p>
            {/* Privacy note - required by issue spec */}
            <div className="mt-4 flex items-center gap-2 rounded-2xl border border-[var(--frost)] bg-white/[0.025] px-4 py-3">
              <Shield className="h-4 w-4 shrink-0 text-[#3b9eff]" />
              <p className="text-xs text-[#a1a4a5]">
                All face data is processed and stored locally on your device. No
                images or face data are ever sent to any external service.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: ["people"] })
              }
              className="frost-button px-5 py-2.5 text-sm font-medium"
            >
              <RefreshCw
                className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => clusterMutation.mutate()}
              disabled={clusterMutation.isPending}
              className="white-pill px-5 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {clusterMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Re-cluster faces
            </button>
          </div>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-32">
            <Loader2 className="h-8 w-8 animate-spin text-[#a1a4a5]" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="frost-panel mx-auto max-w-md rounded-3xl px-8 py-14 text-center">
            <p className="text-[#ff9bab]">Failed to load people</p>
          </div>
        )}

        {/* Empty state */}
        {people && people.length === 0 && (
          <div className="frost-panel mx-auto max-w-md rounded-3xl px-8 py-14 text-center">
            <Users className="mx-auto mb-4 h-10 w-10 text-[#5f6568]" />
            <p className="mb-2 text-[#f0f0f0]">No people found yet</p>
            <p className="mb-6 text-sm leading-6 text-[#a1a4a5]">
              Upload photos with faces, then run face clustering.
            </p>
            <button
              type="button"
              onClick={() => clusterMutation.mutate()}
              disabled={clusterMutation.isPending}
              className="white-pill px-5 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              Run face clustering
            </button>
          </div>
        )}

        {/* People grid */}
        {people && people.length > 0 && (
          <div className="page-enter">
            <div className="mb-8 grid gap-3 sm:grid-cols-2">
              <div className="frost-panel rounded-2xl p-4">
                <p className="text-xs uppercase text-[#5f6568]">People found</p>
                <p className="mt-2 text-3xl font-light text-[#f0f0f0]">
                  {people.length}
                </p>
              </div>
              <div className="frost-panel rounded-2xl p-4">
                <p className="text-xs uppercase text-[#5f6568]">Total faces</p>
                <p className="mt-2 text-3xl font-light text-[#f0f0f0]">
                  {people.reduce((sum, p) => sum + p.face_count, 0)}
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {people.map((person) => (
                <PersonCard
                  key={person.id}
                  person={person}
                  onClick={() => setSelectedPersonId(person.id)}
                  onNameSaved={() =>
                    queryClient.invalidateQueries({ queryKey: ["people"] })
                  }
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Person detail modal */}
      {selectedPersonId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 backdrop-blur-xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="person-modal-title"
        >
          <div className="frost-panel page-enter relative max-h-[90dvh] w-full max-w-6xl overflow-hidden rounded-3xl bg-black">
            <button
              type="button"
              onClick={() => setSelectedPersonId(null)}
              className="icon-button absolute right-4 top-4 z-20 bg-black/60 backdrop-blur-md"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="border-b border-[var(--frost)] px-6 py-5">
              <h2
                id="person-modal-title"
                className="text-xl font-medium text-[#f0f0f0]"
              >
                {selectedPersonQuery.data?.person_name ?? "Unknown person"}
              </h2>
              <p className="mt-1 text-sm text-[#a1a4a5]">
                All photos containing this person.
              </p>
            </div>

            <div className="max-h-[calc(90dvh-88px)] overflow-y-auto p-6">
              {selectedPersonQuery.isLoading && (
                <div className="flex items-center justify-center py-24">
                  <Loader2 className="h-8 w-8 animate-spin text-[#a1a4a5]" />
                </div>
              )}

              {selectedPersonQuery.isError && (
                <div className="py-16 text-center text-[#ff9bab]">
                  Failed to load photos.
                </div>
              )}

              {selectedPersonQuery.data && (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                  {selectedPersonQuery.data.images.map((img) => (
                    <div
                      key={img.media_id}
                      className="frost-panel overflow-hidden rounded-3xl"
                    >
                      <div className="relative aspect-square bg-white/[0.025]">
                        <Image
                          src={`${API_BASE_URL}/api/image/${img.media_id}/thumbnail`}
                          alt="Photo"
                          fill
                          className="object-cover"
                          sizes="(max-width: 768px) 50vw, 25vw"
                          unoptimized
                        />
                      </div>
                      <div className="p-3">
                        <p className="text-xs text-[#a1a4a5]">
                          {img.faces.length}{" "}
                          {img.faces.length === 1 ? "face" : "faces"} detected
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
