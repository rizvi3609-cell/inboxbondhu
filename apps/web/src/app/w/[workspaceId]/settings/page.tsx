import { redirect } from 'next/navigation'

export default async function SettingsIndex({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params
  redirect(`/w/${workspaceId}/settings/channels`)
}
