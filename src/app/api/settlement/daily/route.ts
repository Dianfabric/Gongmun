import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { startOfDay, endOfDay, subDays, startOfMonth, endOfMonth, format, getDay } from 'date-fns'

// 영업일수 (토/일 제외한 평균)
const BUSINESS_DAYS_PER_MONTH = 22

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const dateStr = searchParams.get('date')
    const targetDate = dateStr ? new Date(dateStr) : new Date()
    const dayStart = startOfDay(targetDate)
    const dayEnd = endOfDay(targetDate)

    // === 1. 오늘 거래 데이터 ===
    const todayTransactions = await prisma.transaction.findMany({
      where: { date: { gte: dayStart, lte: dayEnd } },
      include: {
        items: { include: { product: true } },
        client: { select: { name: true } },
      },
    })

    // 매출/비용/매입 분류
    const sales = todayTransactions.filter(t => t.type === 'SALE')
    const expenses = todayTransactions.filter(t => t.type === 'EXPENSE')
    const purchases = todayTransactions.filter(t => t.type === 'PURCHASE')

    const totalSales = sales.reduce((s, t) => s + t.totalAmount, 0)
    const totalExpenses = expenses.reduce((s, t) => s + t.totalAmount, 0)
    const totalPurchases = purchases.reduce((s, t) => s + t.totalAmount, 0)

    // === 2. 공헌이익 계산 (전체) ===
    // 공헌이익 = 매출 - 변동비(매출원가 = 제품 매입가 × 수량)
    let totalVariableCost = 0
    const productContributions: Record<string, {
      productId: string; productName: string; category: string
      revenue: number; variableCost: number; quantity: number; unit: string
    }> = {}

    sales.forEach(tx => {
      tx.items.forEach(item => {
        const purchasePrice = item.product?.purchasePrice || 0
        const variableCost = purchasePrice * item.quantity
        totalVariableCost += variableCost

        const key = item.productId || item.productName || 'etc'
        if (!productContributions[key]) {
          productContributions[key] = {
            productId: key,
            productName: item.product?.name || item.productName || '기타',
            category: item.product?.category || '',
            revenue: 0, variableCost: 0, quantity: 0,
            unit: item.product?.unit || 'PIECE',
          }
        }
        productContributions[key].revenue += item.amount
        productContributions[key].variableCost += variableCost
        productContributions[key].quantity += item.quantity
      })
    })

    const totalContributionMargin = totalSales - totalVariableCost
    const contributionMarginRate = totalSales > 0 ? (totalContributionMargin / totalSales) * 100 : 0

    // 제품별 공헌이익 배열 (정렬: 공헌이익 높은 순)
    const productCM = Object.values(productContributions)
      .map(p => ({
        ...p,
        contributionMargin: p.revenue - p.variableCost,
        contributionMarginRate: p.revenue > 0 ? ((p.revenue - p.variableCost) / p.revenue) * 100 : 0,
      }))
      .sort((a, b) => b.contributionMargin - a.contributionMargin)

    // === 3. 고정비 & BEP ===
    const recurringCosts = await prisma.recurringCost.findMany({ include: { costCategory: true } })
    const monthlyFixedCost = recurringCosts.reduce((s, c) => {
      if (c.frequency === 'MONTHLY') return s + c.amount
      if (c.frequency === 'QUARTERLY') return s + Math.round(c.amount / 3)
      if (c.frequency === 'YEARLY') return s + Math.round(c.amount / 12)
      return s
    }, 0)

    const dailyFixedCost = Math.round(monthlyFixedCost / BUSINESS_DAYS_PER_MONTH)
    const dailyOperatingProfit = totalContributionMargin - dailyFixedCost
    const dailyBEPRate = dailyFixedCost > 0 ? (totalContributionMargin / dailyFixedCost) * 100 : 0

    // 월간 누적 BEP
    const monthStart = startOfMonth(targetDate)
    const monthEnd = endOfMonth(targetDate)
    const monthSales = await prisma.transaction.findMany({
      where: { type: 'SALE', date: { gte: monthStart, lte: dayEnd } },
      include: { items: { include: { product: true } } },
    })

    let monthCumulativeCM = 0
    monthSales.forEach(tx => {
      tx.items.forEach(item => {
        const cost = (item.product?.purchasePrice || 0) * item.quantity
        monthCumulativeCM += (item.amount - cost)
      })
    })

    const monthlyBEPRate = monthlyFixedCost > 0 ? (monthCumulativeCM / monthlyFixedCost) * 100 : 0

    // === 4. 현금흐름 ===
    const cashIn = sales.filter(t => t.paymentStatus === 'PAID').reduce((s, t) => s + t.totalAmount, 0)
    const cashOut = [...expenses, ...purchases].filter(t => t.paymentStatus === 'PAID').reduce((s, t) => s + t.totalAmount, 0)
    const netCashFlow = cashIn - cashOut

    // === 5. 당일 신규 미수금 ===
    const newReceivables = await prisma.accountsReceivable.findMany({
      where: { createdAt: { gte: dayStart, lte: dayEnd } },
      include: { client: { select: { name: true } } },
    })
    const newARTotal = newReceivables.reduce((s, ar) => s + ar.originalAmount, 0)

    // === 6. 전일 비교 ===
    const yesterday = subDays(targetDate, 1)
    const ydayStart = startOfDay(yesterday)
    const ydayEnd = endOfDay(yesterday)
    const ydaySales = await prisma.transaction.aggregate({
      where: { type: 'SALE', date: { gte: ydayStart, lte: ydayEnd } },
      _sum: { totalAmount: true }, _count: true,
    })

    let ydayCM = 0
    const ydayTx = await prisma.transaction.findMany({
      where: { type: 'SALE', date: { gte: ydayStart, lte: ydayEnd } },
      include: { items: { include: { product: true } } },
    })
    ydayTx.forEach(tx => {
      tx.items.forEach(item => {
        ydayCM += item.amount - ((item.product?.purchasePrice || 0) * item.quantity)
      })
    })

    // 전주 동요일 비교
    const lastWeekSameDay = subDays(targetDate, 7)
    const lwStart = startOfDay(lastWeekSameDay)
    const lwEnd = endOfDay(lastWeekSameDay)
    const lwSales = await prisma.transaction.aggregate({
      where: { type: 'SALE', date: { gte: lwStart, lte: lwEnd } },
      _sum: { totalAmount: true }, _count: true,
    })

    // === 7. 고정비 상세 ===
    const fixedCostBreakdown = recurringCosts.map(c => ({
      category: c.costCategory.name,
      type: c.costCategory.type,
      description: c.description,
      monthlyAmount: c.frequency === 'MONTHLY' ? c.amount : c.frequency === 'QUARTERLY' ? Math.round(c.amount / 3) : Math.round(c.amount / 12),
      dailyAmount: Math.round((c.frequency === 'MONTHLY' ? c.amount : c.frequency === 'QUARTERLY' ? Math.round(c.amount / 3) : Math.round(c.amount / 12)) / BUSINESS_DAYS_PER_MONTH),
    }))

    return NextResponse.json({
      date: format(targetDate, 'yyyy-MM-dd'),
      dateLabel: format(targetDate, 'yyyy년 MM월 dd일'),

      // 매출/비용 요약
      totalSales,
      totalExpenses,
      totalPurchases,
      salesCount: sales.length,
      expenseCount: expenses.length,

      // 공헌이익 (전체)
      totalVariableCost,
      totalContributionMargin,
      contributionMarginRate,

      // 제품별 공헌이익
      productCM,

      // 고정비 & BEP
      monthlyFixedCost,
      dailyFixedCost,
      dailyOperatingProfit,
      dailyBEPRate,
      monthCumulativeCM,
      monthlyBEPRate,
      fixedCostBreakdown,

      // 현금흐름
      cashIn,
      cashOut,
      netCashFlow,

      // 미수금
      newReceivables: newReceivables.map(ar => ({
        clientName: ar.client.name, amount: ar.originalAmount,
      })),
      newARTotal,

      // 비교
      comparison: {
        yesterday: {
          sales: ydaySales._sum.totalAmount || 0,
          count: ydaySales._count || 0,
          contributionMargin: ydayCM,
        },
        lastWeek: {
          sales: lwSales._sum.totalAmount || 0,
          count: lwSales._count || 0,
        },
      },

      // 거래 상세
      transactions: todayTransactions.map(t => ({
        id: t.id, type: t.type, totalAmount: t.totalAmount,
        paymentMethod: t.paymentMethod, paymentStatus: t.paymentStatus,
        clientName: t.client?.name || '-', channel: t.channel,
        description: t.description,
        items: t.items.map(i => ({ name: i.product?.name || i.productName, quantity: i.quantity, amount: i.amount })),
      })),
    })
  } catch (error) {
    console.error('Settlement API Error:', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
