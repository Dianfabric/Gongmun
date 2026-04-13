import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET - 비용 카테고리 + 고정비용 목록
export async function GET() {
  try {
    const categories = await prisma.costCategory.findMany({
      where: { isActive: true },
      include: {
        recurringCosts: true,
      },
      orderBy: { name: 'asc' },
    })

    // 월간 총 고정비 계산
    let monthlyTotal = 0
    categories.forEach(cat => {
      cat.recurringCosts.forEach(rc => {
        if (rc.frequency === 'MONTHLY') monthlyTotal += rc.amount
        else if (rc.frequency === 'QUARTERLY') monthlyTotal += Math.round(rc.amount / 3)
        else if (rc.frequency === 'YEARLY') monthlyTotal += Math.round(rc.amount / 12)
      })
    })

    return NextResponse.json({ categories, monthlyTotal })
  } catch (error) {
    console.error('Costs GET Error:', error)
    return NextResponse.json({ error: 'Failed to fetch costs' }, { status: 500 })
  }
}

// POST - 비용 카테고리 또는 고정비용 등록
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    if (body.action === 'category') {
      const category = await prisma.costCategory.create({
        data: {
          name: body.name,
          type: body.type,
        },
      })
      return NextResponse.json(category, { status: 201 })
    }

    if (body.action === 'recurring') {
      const recurringCost = await prisma.recurringCost.create({
        data: {
          costCategoryId: body.costCategoryId,
          description: body.description,
          amount: body.amount,
          frequency: body.frequency || 'MONTHLY',
          notes: body.notes || null,
        },
      })
      return NextResponse.json(recurringCost, { status: 201 })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Costs POST Error:', error)
    return NextResponse.json({ error: 'Failed to create cost' }, { status: 500 })
  }
}
