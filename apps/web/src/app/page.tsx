import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'

export default async function Home() {
  const jar = await cookies()
  if (jar.has('ib_at') || jar.has('ib_rt')) redirect('/workspaces')
  redirect('/login')
}
