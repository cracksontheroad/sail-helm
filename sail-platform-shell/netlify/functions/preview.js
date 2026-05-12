export const handler = async (event) => {
    const students = JSON.parse(event.body);

    const results = students.map(student => {
        const current = Number(student.currentGrade) || 0;

        return {
            studentName: student.studentName,
            currentGrade: current,
            aiGrade: Math.min(10, current + 1),
            feedback: "AI preview feedback"
        };
    });

    return {
        statusCode: 200,
        body: JSON.stringify(results)
    };
};
